import { readFile } from "node:fs/promises";

const KIB_PER_GIB = 1024 * 1024;
const DEFAULT_POLL_MS = 10_000;

export interface MemoryAdmissionDeps {
  platform?: NodeJS.Platform;
  readMeminfo?: () => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface WaitForMemoryOptions extends MemoryAdmissionDeps {
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called once, on the first poll that finds the host below the floor. */
  onWait?: (availableGiB: number) => void;
}

export type MemoryAdmission =
  | { admitted: true; availableGiB: number | null; waitedMs: number }
  | {
      admitted: false;
      reason: "aborted" | "timeout";
      availableGiB: number | null;
      waitedMs: number;
    };

export function parseMemAvailableGiB(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10) / KIB_PER_GIB;
}

export async function readMemAvailableGiB(deps: MemoryAdmissionDeps = {}): Promise<number | null> {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  try {
    const read = deps.readMeminfo ?? ((): Promise<string> => readFile("/proc/meminfo", "utf8"));
    const text = await read();
    return parseMemAvailableGiB(text);
  } catch {
    return null;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Waits until /proc/meminfo MemAvailable reaches `minGiB`. Admits immediately
 * off Linux, when the floor is 0, or when meminfo is unreadable — admission is
 * a guard against starting a heavy job into a full host, not a hard dependency.
 */
export async function waitForMemory(
  minGiB: number,
  opts: WaitForMemoryOptions,
): Promise<MemoryAdmission> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const pollMs = Math.max(1, opts.pollMs ?? DEFAULT_POLL_MS);
  const start = now();
  let warned = false;
  for (;;) {
    const waitedMs = now() - start;
    if (opts.signal?.aborted) {
      return { admitted: false, reason: "aborted", availableGiB: null, waitedMs };
    }
    const availableGiB = minGiB > 0 ? await readMemAvailableGiB(opts) : null;
    if (availableGiB === null || availableGiB >= minGiB) {
      return { admitted: true, availableGiB, waitedMs };
    }
    if (waitedMs >= opts.timeoutMs) {
      return { admitted: false, reason: "timeout", availableGiB, waitedMs };
    }
    if (!warned) {
      warned = true;
      opts.onWait?.(availableGiB);
    }
    await sleep(Math.min(pollMs, opts.timeoutMs - waitedMs), opts.signal);
  }
}
