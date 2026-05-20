import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface AgyHandle {
  exited: Promise<number | null>;
  kill(): void;
}

export function spawnAgy(opts: {
  binary: string;
  args: string[];
  onLine: (line: string) => void;
  signal?: AbortSignal;
}): AgyHandle {
  const child = spawn(opts.binary, opts.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  if (child.stdout) {
    const rl = createInterface({
      input: child.stdout,
      terminal: false,
    });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      opts.onLine(trimmed);
    });
  }

  child.stderr?.on('data', (chunk: Buffer) => {
    try {
      process.stderr.write(chunk);
    } catch {
      // Ignore if stderr is unavailable at this stage.
    }
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });

  const signalProcess = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Process may have already exited.
    }
  };

  const kill = () => {
    signalProcess('SIGTERM');
    const timer = setTimeout(() => {
      signalProcess('SIGKILL');
    }, 2000);
    timer.unref();
  };

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => {
      kill();
    }, { once: true });
  }

  return { exited, kill };
}
