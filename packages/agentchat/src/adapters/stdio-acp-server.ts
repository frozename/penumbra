import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

export interface StartStdioAcpServerOptions {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface StdioAcpHandle {
  stdin: Writable;
  stdout: Readable;
  kill: () => void;
  exited: Promise<number | null>;
  pid?: number;
}

export async function startStdioAcpServer(opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> {
  const { binary, args = [], cwd = process.cwd(), env = process.env, signal } = opts;

  const child = spawn(binary, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: process.platform !== 'win32',
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
      // Process may already be gone.
    }
  };

  const kill = () => {
    signalProcess('SIGTERM');
    const timer = setTimeout(() => {
      signalProcess('SIGKILL');
    }, 2000);
    timer.unref();
  };

  if (signal) {
    signal.addEventListener('abort', () => kill(), { once: true });
  }

  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    kill,
    exited,
    pid: child.pid,
  };
}
