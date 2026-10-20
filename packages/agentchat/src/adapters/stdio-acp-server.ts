import type { Readable, Writable } from "node:stream";

import { spawn } from "node:child_process";

import { wrapSandboxExecArgv } from "../worker/sandbox-spawn.js";

export interface StartStdioAcpServerOptions {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Seatbelt (sandbox-exec -p) profile text. When set, the agent subprocess is
   * spawned inside the profile — the OS-level write-deny backstop for
   * permission-profile dispatches (covers native agent writes that bypass
   * penumbra's executor, and propagates to agent-spawned MCP children). Throws
   * SandboxUnavailableError rather than ever spawning unsandboxed.
   */
  sandboxProfile?: string;
  /**
   * Bytes of child stderr to retain for diagnostic surfacing in error paths.
   * The captured tail is exposed via `getStderrTail()` so callers can append
   * it to error messages when a session/prompt times out or the child crashes
   * before responding. Default 8192.
   */
  stderrTailBytes?: number;
}

export interface StdioAcpHandle {
  stdin: Writable;
  stdout: Readable;
  kill: () => void;
  exited: Promise<number | null>;
  pid?: number;
  /** Returns up to the last `stderrTailBytes` of child stderr seen so far. */
  getStderrTail: () => string;
  /**
   * Populated when the child process fails to spawn (ENOENT/EACCES) or emits
   * an `error` event before/without exiting. Callers can surface this to
   * disambiguate `exited === null` (spawn failure) from a SIGKILL exit code.
   * Optional so existing test fixtures/handle stubs don't need to implement it.
   */
  getSpawnError?: () => Error | null;
}

export function startStdioAcpServer(opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> {
  const {
    binary,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    signal,
    stderrTailBytes = 8192,
    sandboxProfile,
  } = opts;
  if (signal?.aborted === true) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("stdio-acp-server: start aborted"),
    );
  }

  const spawnArgv =
    sandboxProfile !== undefined
      ? wrapSandboxExecArgv([binary, ...args], sandboxProfile)
      : [binary, ...args];
  const child = spawn(spawnArgv[0] ?? binary, spawnArgv.slice(1), {
    cwd,
    env,
    // Pipe stderr (was 'inherit') so we can both tee bytes to the worker's
    // stderr (preserves existing log capture in launchd.worker.err.log) and
    // retain a bounded tail buffer that error paths can surface — without
    // this, a crashed/limit-bound CLI's stderr was unattributable to a
    // specific handoff once it landed in the shared worker log.
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const tailChunks: Buffer[] = [];
  let tailBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    try {
      process.stderr.write(chunk);
    } catch {
      /* downstream stderr closed */
    }
    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes > stderrTailBytes && tailChunks.length > 0) {
      const head = tailChunks[0] ?? Buffer.alloc(0);
      const overflow = tailBytes - stderrTailBytes;
      if (head.length <= overflow) {
        tailChunks.shift();
        tailBytes -= head.length;
      } else {
        tailChunks[0] = head.subarray(overflow);
        tailBytes -= overflow;
      }
    }
  });

  let spawnError: Error | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
    child.on("error", (err) => {
      // Retain the error so callers can distinguish ENOENT/EACCES from a
      // clean SIGKILL exit (both otherwise yield exited === null). Log with
      // adapter+binary context so a misconfigured binary path is not silent
      // in worker logs.
      spawnError = err;
      console.error(
        `stdio-acp-server: spawn error for binary=${binary} args=${JSON.stringify(args)}: ${err.message}`,
      );
      resolve(null);
    });
  });

  const signalProcess = (sig: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, sig);
      } else {
        child.kill(sig);
      }
    } catch {
      // Process may already be gone.
    }
  };

  const kill = (): void => {
    signalProcess("SIGTERM");
    const timer = setTimeout(() => {
      signalProcess("SIGKILL");
    }, 2000);
    timer.unref();
  };

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        kill();
      },
      { once: true },
    );
  }

  const stdin: Writable = child.stdin;
  const stdout: Readable = child.stdout;
  return Promise.resolve({
    stdin,
    stdout,
    kill,
    exited,
    pid: child.pid,
    getStderrTail: () => Buffer.concat(tailChunks).toString("utf8"),
    getSpawnError: () => spawnError,
  });
}
