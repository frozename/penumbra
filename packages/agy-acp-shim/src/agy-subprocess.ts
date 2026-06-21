import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface AgyHandle {
  exited: Promise<number | null>;
  kill: () => void;
}

export function spawnAgy(opts: {
  binary: string;
  args: string[];
  onLine: (line: string) => void;
  prompt?: string;
  signal?: AbortSignal;
}): AgyHandle {
  const child = spawn(opts.binary, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  if (opts.prompt !== undefined) {
    child.stdin.end(opts.prompt);
  } else {
    child.stdin.end();
  }

  const rl = createInterface({
    input: child.stdout,
    terminal: false,
  });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    opts.onLine(line);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    try {
      process.stderr.write(chunk);
    } catch {
      // Ignore if stderr is unavailable at this stage.
    }
  });

  let hasExited = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      hasExited = true;
      resolve(code);
    });
    child.on("error", () => {
      hasExited = true;
      resolve(null);
    });
  });

  const signalProcess = (signal: NodeJS.Signals): void => {
    if (!child.pid || hasExited) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Process may have already exited.
    }
  };

  const kill = (): void => {
    if (hasExited) return;
    signalProcess("SIGTERM");
    const timer = setTimeout(() => {
      signalProcess("SIGKILL");
    }, 2000);
    timer.unref();
    void exited.then(() => {
      clearTimeout(timer);
    });
  };

  if (opts.signal) {
    opts.signal.addEventListener(
      "abort",
      () => {
        kill();
      },
      { once: true },
    );
  }

  return { exited, kill };
}
