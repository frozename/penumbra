import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;
const MAX_BOOT_OUTPUT_CHARS = 8_192;
const PORT_PATTERNS = [
  /(?:listening on|port[: =])\s*(\d+)/i,
  /127\.0\.0\.1:(\d+)/i,
];

export interface AcpServerHandle {
  port: number;
  baseUrl: string;
  pid: number;
  kill(timeoutMs?: number): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export type AcpServerSpawner = (
  command: string,
  args: string[],
  options: NonNullable<Parameters<typeof spawn>[2]>,
) => ChildProcessWithoutNullStreams;

export interface StartAcpServerOptions {
  cwd: string;
  pure?: boolean;
  signal?: AbortSignal;
  opencodeBinary?: string;
  bootTimeoutMs?: number;
  spawn?: AcpServerSpawner;
}

function appendBootOutput(output: string, chunk: string): string {
  const next = output + chunk;
  if (next.length <= MAX_BOOT_OUTPUT_CHARS) return next;
  return next.slice(-MAX_BOOT_OUTPUT_CHARS);
}

function parsePortFromText(text: string): number | null {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      return port;
    }
  }
  return null;
}

function createAbortError(reason?: unknown): Error {
  const err = new Error('ACP server start aborted');
  err.name = 'AbortError';
  if (reason instanceof Error) {
    (err as Error & { cause?: unknown }).cause = reason;
  }
  return err;
}

function formatBootError(prefix: string, bootOutput: string): Error {
  const detail = bootOutput.trim();
  return new Error(detail ? `${prefix}\n${detail}` : prefix);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      resolve({ code, signal });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

export async function startAcpServer(opts: StartAcpServerOptions): Promise<AcpServerHandle> {
  if (opts.signal?.aborted) {
    throw createAbortError(opts.signal.reason);
  }

  const args = ['acp', '--port', '0', '--cwd', opts.cwd];
  if (opts.pure !== false) args.push('--pure');

  const spawnProcess = opts.spawn ?? spawn;
  const child = spawnProcess(opts.opencodeBinary ?? 'opencode', args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.pid == null) {
    throw new Error('ACP server failed to start: child process has no pid');
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const exited = waitForExit(child);
  let killPromise: Promise<void> | null = null;

  const kill = async (timeoutMs = DEFAULT_KILL_TIMEOUT_MS): Promise<void> => {
    if (killPromise) return killPromise;
    killPromise = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }

      try {
        child.kill('SIGTERM');
      } catch {
        await exited;
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exited.then(() => 'exited' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
          }),
        ]);

        if (result === 'timeout') {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          await exited;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    return killPromise;
  };

  return new Promise<AcpServerHandle>((resolve, reject) => {
    const bootTimeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    let bootSettled = false;
    let bootOutput = '';

    const cleanupBootListeners = () => {
      clearTimeout(bootTimer);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
    };

    const failBoot = async (err: Error) => {
      if (bootSettled) return;
      bootSettled = true;
      cleanupBootListeners();
      try {
        await kill();
      } catch {
        // ignore
      }
      reject(err);
    };

    const maybeResolve = (chunk: string) => {
      if (bootSettled) return;
      bootOutput = appendBootOutput(bootOutput, chunk);
      const port = parsePortFromText(chunk) ?? parsePortFromText(bootOutput);
      if (port == null) return;

      bootSettled = true;
      cleanupBootListeners();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        pid: child.pid!,
        kill,
        exited,
      });
    };

    const onStdout = (chunk: string | Buffer) => maybeResolve(chunk.toString());
    const onStderr = (chunk: string | Buffer) => maybeResolve(chunk.toString());
    const onError = (err: Error) => {
      void failBoot(formatBootError(`ACP server failed to spawn: ${err.message}`, bootOutput));
    };
    const onAbort = () => {
      if (!bootSettled) {
        void failBoot(createAbortError(opts.signal?.reason));
        return;
      }
      void kill().catch(() => {});
    };

    const bootTimer = setTimeout(() => {
      void failBoot(
        formatBootError(
          `ACP server did not report a port within ${bootTimeoutMs}ms`,
          bootOutput,
        ),
      );
    }, bootTimeoutMs);

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    void exited.finally(() => {
      opts.signal?.removeEventListener('abort', onAbort);
    });

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);

    void exited.then((info) => {
      if (bootSettled) return;
      void failBoot(
        formatBootError(
          `ACP server exited before reporting a port (code=${info.code}, signal=${info.signal})`,
          bootOutput,
        ),
      );
    });
  });
}
