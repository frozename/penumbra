import { Database } from "bun:sqlite";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { createLogger, type Logger } from "../logger.js";
import {
  type MemoryAdmission,
  waitForMemory,
  type WaitForMemoryOptions,
} from "./memory-admission.js";

const HELPER_EXIT_GRACE_MS = 2_000;
const LEASE_TABLE = "penumbra_heavy_job_lease";

function noop(): void {
  // intentionally empty
}
const LOCKED_MARKER = "locked";

export function defaultHeavyJobLockPath(home: string = homedir()): string {
  return join(home, ".penumbra", "locks", "heavy-job.lock");
}

export interface HeavyJobLease {
  release(): Promise<void>;
}

export interface AcquireOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

type HelperSpawn = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface HeavyJobLockOptions {
  path?: string;
  /** flock(1) binary; null falls back to the SQLite lease unless crossProcessFallback is "none". */
  flockBin?: string | null;
  /**
   * Cross-process mechanism when flockBin is null: "sqlite" (default) holds an
   * EXCLUSIVE transaction on `${path}.lock.db` that the kernel releases if the
   * holder dies; "owner-file" is a deprecated alias for "sqlite"; "none"
   * serializes in-process only.
   */
  crossProcessFallback?: "sqlite" | "owner-file" | "none";
  /** Poll interval while waiting for the SQLite lease. Default 100ms. */
  pollMs?: number;
  spawn?: HelperSpawn;
  log?: Logger;
}

function findFlock(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), "/usr/bin", "/bin"];
  for (const dir of dirs) {
    const candidate = join(dir, "flock");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultHelperSpawn(file: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
}

function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("database is locked") || msg.includes("database is busy");
}

function rollbackQuietly(db: Database): void {
  try {
    db.run("ROLLBACK");
  } catch {
    // No transaction is open when the BEGIN itself lost the race.
  }
}

function sleepPoll(pollMs: number, remainingMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    const onAbort = (): void => {
      finish(true);
    };
    const timer = setTimeout(
      () => {
        finish(false);
      },
      Math.min(pollMs, remainingMs),
    );
    if (signal?.aborted) finish(true);
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** FIFO async mutex whose waiters can give up (timeout / abort). */
class TimedMutex {
  private held = false;
  private readonly waiters: (() => void)[] = [];

  acquire(opts: AcquireOptions): Promise<boolean> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", giveUp);
        const idx = this.waiters.indexOf(grant);
        if (idx !== -1) this.waiters.splice(idx, 1);
      };
      const grant = (): void => {
        cleanup();
        resolve(true);
      };
      const giveUp = (): void => {
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(giveUp, opts.timeoutMs);
      opts.signal?.addEventListener("abort", giveUp, { once: true });
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.held = false;
  }
}

/**
 * Host-wide serialization for heavy jobs. In-process callers queue on a FIFO
 * mutex; across processes the holder keeps a flock(1) helper alive whose stdin
 * is our pipe. The kernel drops the flock when the helper exits, and the helper
 * exits on EOF, so a crashed or SIGKILLed holder never leaves a stale lock.
 * Using flock(1) also makes the lock interoperable with operator wrappers
 * (e.g. a `flock <file> systemd-run …` heavy-job script) pointed at the same file.
 *
 * Where flock(1) is unavailable (e.g. macOS), the default "sqlite" fallback
 * takes the cross-process lease on `${path}.lock.db`: one bun:sqlite
 * connection per held lease keeps a journal_mode=DELETE `BEGIN EXCLUSIVE`
 * transaction open for the whole hold. The EXCLUSIVE transaction takes a
 * kernel-tracked lock on the database file that the OS releases when the
 * process exits or is killed, so a crashed holder never wedges the queue —
 * there is no staleness detection and no reclaim path. Acquire polls
 * `BEGIN EXCLUSIVE` until it succeeds or the waiter's timeout/abort fires;
 * release rolls the transaction back and closes the connection. Set
 * crossProcessFallback to "none" to opt out and serialize in-process only.
 */
export class HeavyJobLock {
  readonly path: string;
  private readonly mutex = new TimedMutex();
  private readonly flockBin: string | null;
  private readonly fallback: "sqlite" | "none";
  private readonly pollMs: number;
  private readonly spawnHelper: HelperSpawn;
  private readonly log: Logger;

  constructor(opts: HeavyJobLockOptions = {}) {
    this.path = opts.path ?? defaultHeavyJobLockPath();
    this.flockBin = opts.flockBin === undefined ? findFlock() : opts.flockBin;
    const fallback = opts.crossProcessFallback ?? "sqlite";
    this.fallback = fallback === "owner-file" ? "sqlite" : fallback;
    this.pollMs = opts.pollMs ?? 100;
    this.spawnHelper = opts.spawn ?? defaultHelperSpawn;
    this.log = opts.log ?? createLogger({ component: "heavy-job-lock" });
  }

  /** False only when flock(1) is unavailable and the SQLite fallback is off: holders serialize in-process only. */
  get crossProcess(): boolean {
    return this.flockBin !== null || this.fallback === "sqlite";
  }

  async acquire(opts: AcquireOptions): Promise<HeavyJobLease | null> {
    const start = Date.now();
    if (!(await this.mutex.acquire(opts))) return null;
    const remainingMs = Math.max(1, opts.timeoutMs - (Date.now() - start));
    let helper: ChildProcessWithoutNullStreams | null = null;
    let leaseDb: Database | null = null;
    if (this.flockBin !== null) {
      const res = await this.acquireFileLock(this.flockBin, {
        ...opts,
        timeoutMs: remainingMs,
      }).catch((err: unknown) => {
        this.log.warn({ path: this.path, err: String(err) }, "heavy-job flock helper failed");
        return null;
      });
      if (res === "timeout") {
        this.mutex.release();
        return null;
      }
      helper = res;
    } else if (this.fallback === "sqlite") {
      const res = await this.acquireSqliteLock({
        ...opts,
        timeoutMs: remainingMs,
      }).catch((err: unknown) => {
        this.log.warn(
          { path: `${this.path}.lock.db`, err: String(err) },
          "heavy-job sqlite lock failed",
        );
        return null;
      });
      if (res === "timeout") {
        this.mutex.release();
        return null;
      }
      leaseDb = res;
    }
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        if (helper) await stopHelper(helper);
        if (leaseDb) this.releaseSqliteLock(leaseDb);
        this.mutex.release();
      },
    };
  }

  /**
   * Poll `BEGIN EXCLUSIVE` on a dedicated connection to `${path}.lock.db`.
   * Each poll first re-asserts journal_mode=DELETE (WAL-mode shared-memory
   * locks are not wanted for a pure mutex) — the pragma itself fails BUSY
   * while a holder is in place, which the loop treats as contention. The
   * CREATE inside the transaction is required: on a never-written database
   * file the pager has not opened anything for `BEGIN EXCLUSIVE` to lock, so
   * the first real page access is what makes the kernel-held lock visible to
   * other processes.
   */
  private async acquireSqliteLock(opts: AcquireOptions): Promise<Database | "timeout" | null> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
    } catch (err) {
      this.log.warn({ path: this.path, err: String(err) }, "heavy-job lock dir unavailable");
      return null;
    }
    const dbPath = `${this.path}.lock.db`;
    let db: Database;
    try {
      db = new Database(dbPath, { create: true });
      db.run("PRAGMA busy_timeout = 0");
    } catch (err) {
      this.log.warn({ path: dbPath, err: String(err) }, "heavy-job sqlite lock db unavailable");
      return null;
    }
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      try {
        db.run("PRAGMA journal_mode = DELETE");
        db.run("BEGIN EXCLUSIVE");
        db.run(`CREATE TABLE IF NOT EXISTS ${LEASE_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1))`);
        return db;
      } catch (err) {
        rollbackQuietly(db);
        if (!isSqliteBusy(err)) {
          this.log.warn(
            { path: dbPath, err: String(err) },
            "heavy-job sqlite lock failed; serializing in-process only for this job",
          );
          db.close();
          return null;
        }
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        db.close();
        return "timeout";
      }
      if (await sleepPoll(this.pollMs, remainingMs, opts.signal)) {
        db.close();
        return "timeout";
      }
    }
  }

  private releaseSqliteLock(db: Database): void {
    const dbPath = `${this.path}.lock.db`;
    try {
      db.run("ROLLBACK");
    } catch (err) {
      this.log.warn({ path: dbPath, err: String(err) }, "heavy-job sqlite lock release failed");
    }
    try {
      db.close();
    } catch (err) {
      this.log.warn({ path: dbPath, err: String(err) }, "heavy-job sqlite lock close failed");
    }
  }

  private async acquireFileLock(
    flockBin: string,
    opts: AcquireOptions,
  ): Promise<ChildProcessWithoutNullStreams | "timeout" | null> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
    } catch (err) {
      this.log.warn({ path: this.path, err: String(err) }, "heavy-job lock dir unavailable");
      return null;
    }
    const helper = this.spawnHelper(flockBin, [
      this.path,
      "/bin/sh",
      "-c",
      `printf '${LOCKED_MARKER}\\n'; exec cat >/dev/null`,
    ]);
    // Late pipe/process errors (EPIPE on release, helper already gone) must not
    // surface as unhandled 'error' events in the worker.
    helper.on("error", noop);
    helper.stdin.on("error", noop);
    const outcome = await new Promise<"locked" | "timeout" | "failed">((resolve) => {
      let out = "";
      const finish = (value: "failed" | "locked" | "timeout"): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        helper.stdout.removeListener("data", onData);
        helper.removeListener("close", onClose);
        helper.removeListener("error", onError);
        resolve(value);
      };
      const onData = (chunk: Buffer): void => {
        out += chunk.toString();
        if (out.includes(LOCKED_MARKER)) finish("locked");
      };
      const onClose = (): void => {
        finish("failed");
      };
      const onError = (): void => {
        finish("failed");
      };
      const onAbort = (): void => {
        finish("timeout");
      };
      const timer = setTimeout(onAbort, opts.timeoutMs);
      helper.stdout.on("data", onData);
      helper.once("close", onClose);
      helper.once("error", onError);
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (outcome === "locked") return helper;
    helper.kill("SIGKILL");
    if (outcome === "timeout") return "timeout";
    this.log.warn(
      { path: this.path },
      "heavy-job flock helper failed; serializing in-process only for this job",
    );
    return null;
  }
}

function stopHelper(helper: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (helper.exitCode !== null || helper.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      helper.kill("SIGKILL");
    }, HELPER_EXIT_GRACE_MS);
    helper.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    helper.stdin.end();
  });
}

export type HeavyJobGateEntry =
  | { ok: true; admission: MemoryAdmission; release: () => Promise<void> }
  | { ok: false; reason: string };

export interface HeavyJobGate {
  enter(label: string, signal?: AbortSignal): Promise<HeavyJobGateEntry>;
}

export interface HeavyJobGateOptions {
  lock: HeavyJobLock;
  admitMinGiB: number;
  waitMs: number;
  log?: Logger;
  memory?: Omit<WaitForMemoryOptions, "onWait" | "signal" | "timeoutMs">;
}

/**
 * Serialize-then-admit: take the host-wide lock first, then wait for the
 * memory floor while holding it, so two waiters cannot both observe enough
 * memory and start together.
 */
export function createHeavyJobGate(opts: HeavyJobGateOptions): HeavyJobGate {
  const log = opts.log ?? createLogger({ component: "heavy-job-gate" });
  return {
    async enter(label: string, signal?: AbortSignal): Promise<HeavyJobGateEntry> {
      const lease = await opts.lock.acquire({ timeoutMs: opts.waitMs, signal });
      if (!lease) {
        return {
          ok: false,
          reason: `heavy-job lock ${opts.lock.path} not acquired within ${String(Math.round(opts.waitMs / 1000))}s`,
        };
      }
      const admission = await waitForMemory(opts.admitMinGiB, {
        ...opts.memory,
        timeoutMs: opts.waitMs,
        signal,
        onWait: (availableGiB) => {
          log.info(
            { label, available_gib: Number(availableGiB.toFixed(1)), min_gib: opts.admitMinGiB },
            "heavy job waiting for memory admission",
          );
        },
      });
      if (!admission.admitted) {
        await lease.release();
        const available =
          admission.availableGiB === null ? "unknown" : admission.availableGiB.toFixed(1);
        return {
          ok: false,
          reason: `host memory admission ${admission.reason}: MemAvailable ${available} GiB < ${String(opts.admitMinGiB)} GiB after ${String(Math.round(admission.waitedMs / 1000))}s`,
        };
      }
      return { ok: true, admission, release: () => lease.release() };
    },
  };
}
