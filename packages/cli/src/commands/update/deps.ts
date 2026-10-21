import { appendFile, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { Clock, Exec, ExecOptions, ExecResult, FsPort, HostPort, Http } from "./types.js";

const MAX_LOG_READ_BYTES = 8 * 1024 * 1024;

type PipedProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

function spawnPiped(argv: readonly string[], opts: ExecOptions): PipedProcess {
  return Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: opts.env ? { ...opts.env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export const defaultExec: Exec = async (argv, opts = {}) => {
  let child: PipedProcess;
  try {
    child = spawnPiped(argv, opts);
  } catch (err) {
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  const timeout = { hit: false };
  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timeout.hit = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  const result: ExecResult = { code: timeout.hit ? 124 : code, stdout, stderr };
  return result;
};

export const defaultHttp: Http = async (url, init = {}) => {
  const res = await fetch(url, {
    headers: init.headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? 3_000),
  });
  return { status: res.status, text: await res.text() };
};

async function readFrom(path: string, offset: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(offset, size - MAX_LOG_READ_BYTES);
    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export const defaultFs: FsPort = {
  readText: async (path) => await readFile(path, "utf8").catch(() => null),
  appendText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text, "utf8");
  },
  size: async (path) => {
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  },
  readFrom: async (path, offset) => await readFrom(path, offset).catch(() => ""),
  realpath: async (path) => await realpath(path),
};

export const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export function createDefaultHost(exec: Exec): HostPort {
  const port: HostPort = {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    selfCgroup: async () => await readFile("/proc/self/cgroup", "utf8").catch(() => null),
    parentPid: async (pid) => {
      const res = await exec(["ps", "-o", "ppid=", "-p", String(pid)], { timeoutMs: 5_000 });
      const ppid = Number(res.stdout.trim());
      return res.code === 0 && Number.isInteger(ppid) && ppid > 0 ? ppid : null;
    },
    children: async (pid) => {
      const res = await exec(["pgrep", "-l", "-P", String(pid)], { timeoutMs: 5_000 });
      return res.code === 0 ? res.stdout.split("\n").filter((line) => line.trim() !== "") : [];
    },
  };
  return port;
}
