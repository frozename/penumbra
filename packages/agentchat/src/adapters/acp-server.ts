import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as net from "node:net";

import { wrapSandboxExecArgv } from "../worker/sandbox-spawn.js";

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

type AcpServerPortWaiter = (port: number, timeoutMs: number, signal?: AbortSignal) => Promise<void>;

export interface StartAcpServerOptions {
  cwd: string;
  pure?: boolean;
  signal?: AbortSignal;
  opencodeBinary?: string;
  bootTimeoutMs?: number;
  env?: Record<string, string>;
  unsetEnv?: string[];
  spawn?: AcpServerSpawner;
  getPort?: () => Promise<number>;
  waitForPort?: AcpServerPortWaiter;
  onChildErrorAfterBoot?: (err: Error) => void;
  /**
   * Seatbelt (sandbox-exec -p) profile text. When set, the agent server
   * subprocess is spawned inside the profile — the OS-level write-deny
   * backstop for permission-profile dispatches (covers native agent writes
   * that bypass penumbra's executor and propagates to agent-spawned MCP
   * children). Throws SandboxUnavailableError rather than ever spawning
   * unsandboxed.
   */
  sandboxProfile?: string;
  /** Test seam for the sandbox-exec availability assertion. */
  sandboxDeps?: { platform?: NodeJS.Platform; exists?: (path: string) => boolean };
}

function noop(): void {
  /* intentionally empty */
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
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      resolve({ code, signal });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(code, signal);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(code, signal);
    };
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
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

function waitForPort(port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    const start = Date.now();
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    function cleanup(): void {
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    function onAbort(): void {
      if (settled) return;
      cleanup();
      reject(createAbortError(signal?.reason));
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    function attempt(): void {
      if (settled) return;
      if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error(`Timed out waiting for port ${String(port)}`));
        return;
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

interface ChildErrorBridge {
  childError: Promise<never>;
  onChildError: (err: Error) => void;
  markBootSettled: () => void;
  isBootSettled: () => boolean;
}

function installChildErrorBridge(
  child: ChildProcessWithoutNullStreams,
  onChildErrorAfterBoot: (err: Error) => void = (err) => {
    console.warn("[acp-server] child process error after boot", err);
  },
): ChildErrorBridge {
  let bootSettled = false;
  let rejectChildError!: (err: Error) => void;
  const childError = new Promise<never>((_, reject) => {
    rejectChildError = reject;
  });
  // Always-attached consumer: a spawn error that fires after the boot race
  // settled (or after a pre-race throw, e.g. the missing-pid path) must never
  // escape as an unhandled rejection — that is the worker-killing bug this
  // module exists to prevent.
  void childError.catch(noop);
  const onChildError = (err: Error): void => {
    if (!bootSettled) {
      rejectChildError(err);
    } else {
      onChildErrorAfterBoot(err);
    }
  };
  child.on("error", onChildError);
  return {
    childError,
    onChildError,
    markBootSettled: (): void => {
      bootSettled = true;
    },
    isBootSettled: (): boolean => bootSettled,
  };
}

function createKiller(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): (timeoutMs?: number) => Promise<void> {
  let killPromise: Promise<void> | null = null;
  const signalProcess = (sig: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32" && process.env.PENUMBRA_OPENCODE_GROUP_KILL !== "0") {
        process.kill(-child.pid, sig);
      } else {
        child.kill(sig);
      }
    } catch {
      // Process may already be gone.
    }
  };

  return async (timeoutMs = DEFAULT_KILL_TIMEOUT_MS): Promise<void> => {
    if (killPromise) {
      await killPromise;
      return;
    }
    killPromise = (async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }

      signalProcess("SIGTERM");

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exited.then((): "exited" => "exited"),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => {
              resolve("timeout");
            }, timeoutMs);
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

    await killPromise;
  };
}

export async function startAcpServer(opts: StartAcpServerOptions): Promise<AcpServerHandle> {
  if (opts.signal?.aborted) {
    throw createAbortError(opts.signal.reason);
  }

  const port = await (opts.getPort ?? getFreePort)();
  if (opts.signal?.aborted) {
    throw createAbortError(opts.signal.reason);
  }

  const child = spawnAcpChild(opts, port);

  const bridge = installChildErrorBridge(child, opts.onChildErrorAfterBoot);

  if (child.pid === undefined) {
    throw new Error("ACP server failed to start: child process has no pid");
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const exited = waitForExit(child);
  void exited.finally(() => {
    child.removeListener("error", bridge.onChildError);
  });

  const kill = createKiller(child, exited);

  const bootTimeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  await runBootRace(
    child,
    port,
    bootTimeoutMs,
    opts.signal,
    bridge,
    kill,
    exited,
    opts.waitForPort ?? waitForPort,
  );

  return {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    pid: child.pid,
    kill,
    exited,
  };
}

function spawnAcpChild(opts: StartAcpServerOptions, port: number): ChildProcessWithoutNullStreams {
  const args = ["acp", "--port", port.toString(), "--cwd", opts.cwd];
  if (opts.pure !== false) args.push("--pure");

  const childEnv = ((): NodeJS.ProcessEnv | undefined => {
    const env = opts.env
      ? { ...process.env, ...opts.env }
      : opts.unsetEnv?.length
        ? { ...process.env }
        : undefined;
    if (env && opts.unsetEnv) {
      const unset = new Set(opts.unsetEnv);
      return Object.fromEntries(Object.entries(env).filter(([key]) => !unset.has(key)));
    }
    return env;
  })();

  const spawnArgv =
    opts.sandboxProfile !== undefined
      ? wrapSandboxExecArgv(
          [opts.opencodeBinary ?? "opencode", ...args],
          opts.sandboxProfile,
          opts.sandboxDeps,
        )
      : [opts.opencodeBinary ?? "opencode", ...args];

  const spawnProcess = opts.spawn ?? spawn;
  const child = spawnProcess(spawnArgv[0] ?? "opencode", spawnArgv.slice(1), {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    detached: process.platform !== "win32",
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("ACP server failed to start: spawn returned null streams");
  }
  return child as ChildProcessWithoutNullStreams;
}

async function runBootRace(
  child: ChildProcessWithoutNullStreams,
  port: number,
  bootTimeoutMs: number,
  signal: AbortSignal | undefined,
  bridge: ChildErrorBridge,
  kill: (timeoutMs?: number) => Promise<void>,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  waitForPortFn: AcpServerPortWaiter,
): Promise<void> {
  let bootOutput = "";

  const onStdout = (chunk: string | Buffer): void => {
    bootOutput = appendBootOutput(bootOutput, chunk.toString());
  };
  const onStderr = (chunk: string | Buffer): void => {
    bootOutput = appendBootOutput(bootOutput, chunk.toString());
  };

  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);

  try {
    await Promise.race([
      waitForPortFn(port, bootTimeoutMs, signal),
      bridge.childError,
      exited.then((info) => {
        // Only an exit DURING boot is a boot failure. After a successful boot
        // this dangling continuation still runs on natural exit; throwing then
        // would be an unhandled rejection that kills the worker.
        if (bridge.isBootSettled()) return undefined as never;
        throw formatBootError(
          `ACP server exited before TCP port was bound (code=${String(info.code)}, signal=${String(info.signal)})`,
          bootOutput,
        );
      }),
    ]);
  } catch (err) {
    bridge.markBootSettled();
    child.stdout.removeListener("data", onStdout);
    child.stderr.removeListener("data", onStderr);
    await kill().catch(noop);
    throw err;
  }

  bridge.markBootSettled();
  child.stdout.removeListener("data", onStdout);
  child.stderr.removeListener("data", onStderr);
}
