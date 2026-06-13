import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as net from "node:net";

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;
const MAX_BOOT_OUTPUT_CHARS = 8_192;

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
  env?: Record<string, string>;
  spawn?: AcpServerSpawner;
}

function appendBootOutput(output: string, chunk: string): string {
  const next = output + chunk;
  if (next.length <= MAX_BOOT_OUTPUT_CHARS) return next;
  return next.slice(-MAX_BOOT_OUTPUT_CHARS);
}

function createAbortError(reason?: unknown): Error {
  const err = new Error("ACP server start aborted");
  err.name = "AbortError";
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
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      resolve({ code, signal });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(createAbortError(signal.reason));
    }

    const start = Date.now();
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    function cleanup() {
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      if (settled) return;
      cleanup();
      reject(createAbortError(signal?.reason));
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    function attempt() {
      if (settled) return;
      if (Date.now() - start > timeoutMs) {
        cleanup();
        return reject(new Error(`Timed out waiting for port ${port}`));
      }

      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        if (settled) return;
        cleanup();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (settled) return;
        timer = setTimeout(attempt, 50);
      });
    }

    attempt();
  });
}

export async function startAcpServer(opts: StartAcpServerOptions): Promise<AcpServerHandle> {
  if (opts.signal?.aborted) {
    throw createAbortError(opts.signal.reason);
  }

  const port = await getFreePort();
  if (opts.signal?.aborted) {
    throw createAbortError(opts.signal.reason);
  }

  const args = ["acp", "--port", port.toString(), "--cwd", opts.cwd];
  if (opts.pure !== false) args.push("--pure");

  const spawnProcess = opts.spawn ?? spawn;
  const child = spawnProcess(opts.opencodeBinary ?? "opencode", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    detached: process.platform !== "win32",
  });

  let bootSettled = false;
  let rejectChildError!: (err: Error) => void;
  const childError = new Promise<never>((_, reject) => {
    rejectChildError = reject;
  });
  // Always-attached consumer: a spawn error that fires after the boot race
  // settled (or after a pre-race throw, e.g. the missing-pid path) must never
  // escape as an unhandled rejection — that is the worker-killing bug this
  // module exists to prevent.
  void childError.catch(() => {});
  const onChildError = (err: Error) => {
    if (!bootSettled) {
      rejectChildError(err);
    } else {
      console.warn("[acp-server] child process error after boot", err);
    }
  };
  child.on("error", onChildError);

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("ACP server failed to start: spawn returned null streams");
  }
  const streamChild = child as ChildProcessWithoutNullStreams;

  if (child.pid == null) {
    throw new Error("ACP server failed to start: child process has no pid");
  }

  streamChild.stdout.setEncoding("utf8");
  streamChild.stderr.setEncoding("utf8");

  const exited = waitForExit(streamChild);
  void exited.finally(() => {
    child.removeListener("error", onChildError);
  });
  let killPromise: Promise<void> | null = null;
  const signalProcess = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32" && process.env.PENUMBRA_OPENCODE_GROUP_KILL !== "0") {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Process may already be gone.
    }
  };

  const kill = async (timeoutMs = DEFAULT_KILL_TIMEOUT_MS): Promise<void> => {
    if (killPromise) return killPromise;
    killPromise = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }

      signalProcess("SIGTERM");

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exited.then(() => "exited" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
          }),
        ]);

        if (result === "timeout") {
          signalProcess("SIGKILL");
          await exited;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    return killPromise;
  };

  const bootTimeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  let bootOutput = "";

  const onStdout = (chunk: string | Buffer) => {
    bootOutput = appendBootOutput(bootOutput, chunk.toString());
  };
  const onStderr = (chunk: string | Buffer) => {
    bootOutput = appendBootOutput(bootOutput, chunk.toString());
  };

  streamChild.stdout.on("data", onStdout);
  streamChild.stderr.on("data", onStderr);

  try {
    await Promise.race([
      waitForPort(port, bootTimeoutMs, opts.signal),
      childError,
      exited.then((info) => {
        // Only an exit DURING boot is a boot failure. After a successful boot
        // this dangling continuation still runs on natural exit; throwing then
        // would be an unhandled rejection that kills the worker.
        if (bootSettled) return undefined as never;
        throw formatBootError(
          `ACP server exited before TCP port was bound (code=${info.code}, signal=${info.signal})`,
          bootOutput,
        );
      }),
    ]);
  } catch (err) {
    bootSettled = true;
    streamChild.stdout.removeListener("data", onStdout);
    streamChild.stderr.removeListener("data", onStderr);
    await kill().catch(() => {});
    throw err;
  }

  bootSettled = true;
  streamChild.stdout.removeListener("data", onStdout);
  streamChild.stderr.removeListener("data", onStderr);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    pid: child.pid,
    kill,
    exited,
  };
}
