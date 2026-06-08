import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Machine-level advisory lock so that exactly ONE worker on a host polls the
 * machine-global usage sources (codex rollout dir, opencode db/console, claude
 * jsonl/statusline). Every worker would otherwise read the same shared sources
 * and emit identical event_ids — harmless (the daemon's /observations route is
 * idempotent) but wasteful.
 *
 * Self-organizing with failover: the holder refreshes `ts` every poll tick; a
 * non-holder takes over once the lock goes stale — i.e. the holder has not
 * refreshed within `staleMs` (≈2.5 ticks). Detection is purely timestamp-based;
 * we deliberately do NOT probe holder-pid liveness, which is unreliable across
 * processes (a recycled pid can make a dead holder look alive and starve
 * polling). The trade-off: a crashed or hung holder keeps the lock for up to
 * `staleMs` (~150s by default) before another worker takes over. A brief
 * double-hold around a takeover race is acceptable — the idempotent
 * /observations route absorbs the duplicates and the read-back below makes it
 * self-correct within one tick.
 */
export interface UsagePollLockState {
  workerId: string;
  pid: number;
  ts: number;
}

export interface AcquireUsagePollLockOpts {
  lockPath: string;
  workerId: string;
  now: number;
  /** A held lock older than this (no refresh) is considered abandoned. */
  staleMs: number;
  pid?: number;
}

export function readUsagePollLock(lockPath: string): UsagePollLockState | null {
  try {
    if (!existsSync(lockPath)) return null;
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<UsagePollLockState>;
    if (
      typeof parsed.workerId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.ts !== "number"
    ) {
      return null;
    }
    return { workerId: parsed.workerId, pid: parsed.pid, ts: parsed.ts };
  } catch {
    return null;
  }
}

/**
 * Try to become (or stay) the machine's single usage poller. Returns true iff
 * this worker holds the lock after the call. Safe to call every tick: the holder
 * refreshes its timestamp, non-holders no-op while the holder stays fresh.
 */
export function acquireOrRefreshUsagePollLock(opts: AcquireUsagePollLockOpts): boolean {
  const pid = opts.pid ?? process.pid;
  const current = readUsagePollLock(opts.lockPath);

  const heldByFreshOther =
    current !== null && current.workerId !== opts.workerId && opts.now - current.ts < opts.staleMs;
  if (heldByFreshOther) return false;

  // Free / stale / already-mine: claim via atomic write, then read back to
  // confirm we won any concurrent race (last rename wins).
  const next: UsagePollLockState = { workerId: opts.workerId, pid, ts: opts.now };
  mkdirSync(dirname(opts.lockPath), { recursive: true });
  const tmp = `${opts.lockPath}.${String(pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`);
  renameSync(tmp, opts.lockPath);

  const after = readUsagePollLock(opts.lockPath);
  return after !== null && after.workerId === opts.workerId && after.pid === pid;
}
