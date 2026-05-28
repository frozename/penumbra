import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface StartStdioAcpServerOptions {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
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
}

export async function startStdioAcpServer(
  opts: StartStdioAcpServerOptions,
): Promise<StdioAcpHandle> {
  const {
    binary,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    signal,
    stderrTailBytes = 8192,
  } = opts;

  const child = spawn(binary, args, {
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
  child.stderr?.on("data", (chunk: Buffer) => {
    try {
      process.stderr.write(chunk);
    } catch {
      /* downstream stderr closed */
    }
    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes > stderrTailBytes && tailChunks.length > 0) {
      const head = tailChunks[0]!;
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

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });

  const signalProcess = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Process may already be gone.
    }
  };

  const kill = () => {
    signalProcess("SIGTERM");
    const timer = setTimeout(() => {
      signalProcess("SIGKILL");
    }, 2000);
    timer.unref();
  };

  if (signal) {
    signal.addEventListener("abort", () => kill(), { once: true });
  }

  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    kill,
    exited,
    pid: child.pid,
    getStderrTail: () => Buffer.concat(tailChunks).toString("utf8"),
  };
}
