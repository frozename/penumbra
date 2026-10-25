import { appendFile, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  Clock,
  Exec,
  ExecOptions,
  ExecResult,
  FsPort,
  HostChild,
  HostPort,
  Http,
  OnSignal,
} from "./types.js";

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
  const onAbort = (): void => {
    child.kill("SIGTERM");
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
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

export function parseEtime(raw: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
  if (match === null) return null;
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const hours = match[2] === undefined ? 0 : Number(match[2]);
  const minutes = match[3];
  const seconds = match[4];
  if (minutes === undefined || seconds === undefined) return null;
  if (Number(minutes) > 59 || Number(seconds) > 59) return null;
  return days * 86_400 + hours * 3_600 + Number(minutes) * 60 + Number(seconds);
}

function parsePsRow(line: string): HostChild | null {
  const match = /^\s*(\d+)\s+(\S+)/.exec(line);
  if (match === null) return null;
  const pid = match[1];
  const etime = match[2];
  if (pid === undefined || etime === undefined) return null;
  const command = line.slice(match[0].length).trim();
  return {
    pid: Number(pid),
    ageS: parseEtime(etime),
    argv: command === "" ? [] : command.split(/\s+/),
  };
}

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
    childProcesses: async (pid) => {
      const listing = await exec(["pgrep", "-P", String(pid)], { timeoutMs: 5_000 });
      if (listing.code !== 0) return [];
      const pids = listing.stdout.split("\n").filter((line) => line.trim() !== "");
      if (pids.length === 0) return [];
      const res = await exec(["ps", "-o", "pid=,etime=,command=", "-p", pids.join(",")], {
        timeoutMs: 5_000,
      });
      if (res.code !== 0) {
        // Fail closed: pids exist but are unresolvable; block with ageS null and an
        // argv that can never match a seat so they are never ignored.
        return pids.map((pid) => ({ pid: Number(pid), ageS: null, argv: [] }));
      }
      return res.stdout
        .split("\n")
        .map(parsePsRow)
        .filter((child): child is HostChild => child !== null);
    },
  };
  return port;
}

const HANDLED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** While registered, these signals no longer kill the process; the handler decides. */
export const defaultOnSignal: OnSignal = (handler) => {
  const listener = (signal: NodeJS.Signals): void => {
    handler(signal);
  };
  for (const signal of HANDLED_SIGNALS) process.on(signal, listener);
  return () => {
    for (const signal of HANDLED_SIGNALS) process.off(signal, listener);
  };
};
