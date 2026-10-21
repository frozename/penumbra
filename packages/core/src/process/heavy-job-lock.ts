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
  /** flock(1) binary; null disables the cross-process lock (in-process only). */
  flockBin?: string | null;
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
 */
export class HeavyJobLock {
  readonly path: string;
  private readonly mutex = new TimedMutex();
  private readonly flockBin: string | null;
  private readonly spawnHelper: HelperSpawn;
  private readonly log: Logger;

  constructor(opts: HeavyJobLockOptions = {}) {
    this.path = opts.path ?? defaultHeavyJobLockPath();
    this.flockBin = opts.flockBin === undefined ? findFlock() : opts.flockBin;
    this.spawnHelper = opts.spawn ?? defaultHelperSpawn;
    this.log = opts.log ?? createLogger({ component: "heavy-job-lock" });
  }

  async acquire(opts: AcquireOptions): Promise<HeavyJobLease | null> {
    const start = Date.now();
    if (!(await this.mutex.acquire(opts))) return null;
    const remainingMs = Math.max(1, opts.timeoutMs - (Date.now() - start));
    let helper: ChildProcessWithoutNullStreams | null = null;
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
    }
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        if (helper) await stopHelper(helper);
        this.mutex.release();
      },
    };
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
