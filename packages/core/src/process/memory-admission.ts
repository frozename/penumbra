import { readFile } from "node:fs/promises";

const KIB_PER_GIB = 1024 * 1024;
const DEFAULT_POLL_MS = 10_000;
export const DEFAULT_ADMIT_MIN_GIB = 20;
export const DEFAULT_ADMIT_MEMTOTAL_FRACTION = 0.2;

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

const MEMINFO_FIELD_RE = {
  MemAvailable: /^MemAvailable:\s+(\d+)\s+kB/m,
  MemTotal: /^MemTotal:\s+(\d+)\s+kB/m,
} as const;

function parseMeminfoGiB(meminfo: string, field: keyof typeof MEMINFO_FIELD_RE): number | null {
  const match = MEMINFO_FIELD_RE[field].exec(meminfo);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10) / KIB_PER_GIB;
}

export function parseMemAvailableGiB(meminfo: string): number | null {
  return parseMeminfoGiB(meminfo, "MemAvailable");
}

export function parseMemTotalGiB(meminfo: string): number | null {
  return parseMeminfoGiB(meminfo, "MemTotal");
}

async function readMeminfoGiB(
  field: keyof typeof MEMINFO_FIELD_RE,
  deps: MemoryAdmissionDeps,
): Promise<number | null> {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  try {
    const read = deps.readMeminfo ?? ((): Promise<string> => readFile("/proc/meminfo", "utf8"));
    return parseMeminfoGiB(await read(), field);
  } catch {
    return null;
  }
}

export async function readMemAvailableGiB(deps: MemoryAdmissionDeps = {}): Promise<number | null> {
  return await readMeminfoGiB("MemAvailable", deps);
}

/**
 * The admission floor: an explicit value as-is, otherwise
 * min(20 GiB, 20% of MemTotal) so a host far smaller than the Z13 (a 16 GiB CI
 * runner) is not held below an unreachable floor. Off Linux, or with
 * MemTotal unreadable, the default is 20 GiB (waitForMemory is a no-op there).
 */
export async function resolveAdmitMinGiB(
  explicit: number | undefined,
  deps: MemoryAdmissionDeps = {},
): Promise<number> {
  if (explicit !== undefined) return explicit;
  const totalGiB = await readMeminfoGiB("MemTotal", deps);
  if (totalGiB === null) return DEFAULT_ADMIT_MIN_GIB;
  return Math.min(DEFAULT_ADMIT_MIN_GIB, totalGiB * DEFAULT_ADMIT_MEMTOTAL_FRACTION);
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
