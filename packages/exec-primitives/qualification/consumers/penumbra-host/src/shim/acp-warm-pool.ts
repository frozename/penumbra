/**
 * Parity shim: re-creates the legacy `adapters/acp-warm-pool.ts` holder/refcount
 * registry over the extracted `penumbra-exec-primitives` warm pool. Holder
 * tracking, miss classification and capacity policy are host concerns and live
 * here; liveness probing and teardown are delegated to the packed
 * `createAcpWarmPool`, with each logical entry stored under a unique
 * credentialScope slot so pool keys stay shim-managed.
 */
import {
  createAcpWarmPool as createPackedPool,
  type AcpWarmPool as PackedPool,
  type WarmPoolSpec,
} from "penumbra-exec-primitives";

import type { StdioAcpHandle as PackedStdioAcpHandle } from "penumbra-exec-primitives";

import type { StdioAcpClient } from "./stdio-acp-client.js";
import type { StdioAcpHandle } from "./stdio-acp-server.js";

/** Fixture handles may omit getSpawnError; the packed pool never calls it. */
function asPackedHandle(handle: StdioAcpHandle): PackedStdioAcpHandle {
  return handle as PackedStdioAcpHandle;
}

export interface AcpWarmPoolEntry {
  handle: StdioAcpHandle;
  client: StdioAcpClient;
  authMethods?: AcpAuthMethod[];
  /**
   * Vestigial. Under the connection-pool model (Option B) the pool holds a warm
   * process + initialized client, NOT a session — each dispatch
   * issues its own session/new at its own cwd. Kept optional only so older
   * deposit call sites compile; the adapter no longer reads it on reuse.
   */
  sessionId?: string;
  refs: Set<string>;
  lastReleaseAt?: number;
  spawnedAt: number;
  specHash: string;
  tornDown?: boolean;
  /**
   * A pre-warmed (eagerly deposited) connection the worker keeps warm on
   * purpose. Pinned entries are EXEMPT from the idle-grace sweep — otherwise a
   * connection pre-warmed at boot would be reaped ~grace later (5 min on the
   * canary), long before any sparse dispatch arrives, defeating the point. They
   * are still reaped once past max-age (the pre-warm loop replaces them first).
   */
  pinned?: boolean;
  /** Set only by the eager prewarm path; pinned alone is not enough. */
  prewarm?: boolean;
}

export interface AcpWarmPoolDeposit {
  handle: StdioAcpHandle;
  client: StdioAcpClient;
  authMethods?: AcpAuthMethod[];
  sessionId?: string;
  specHash: string;
  pinned?: boolean;
  prewarm?: boolean;
}

export type AcpWarmPoolDepositRejectAction = "kill" | "keep";

export interface AcpWarmPoolPrewarmEviction {
  evictedAgent: string;
  evictedRepoRoot: string;
  depositorAgent: string;
  idleMs: number;
}

export interface AcpWarmPoolDepositOptions {
  onReject?: AcpWarmPoolDepositRejectAction;
  onPrewarmEvicted?: (event: AcpWarmPoolPrewarmEviction) => void;
}

interface AcpAuthMethod {
  id: string;
  type?: string;
  vars?: { name: string }[];
}

export interface AcpWarmPool {
  acquire(holderId: string, key: string, specHash: string): AcpWarmPoolEntry | null;
  deposit(
    key: string,
    entry: AcpWarmPoolDeposit,
    opts?: AcpWarmPoolDepositOptions,
  ): AcpWarmPoolEntry | null;
  release(holderId: string, key: string): void;
  evict(key: string, entry?: AcpWarmPoolEntry): void;
  shutdown(): void;
  /** Total warm entries (live processes) across every key in this pool. Used by
   *  the worker-level pre-warm cap (Phase 4) to bound idle process footprint. */
  size(): number;
  /** True if at least one live (running) entry exists for `key`. Lets the
   *  pre-warm loop self-heal a crashed pre-warm without waiting for the refresh. */
  has(key: string): boolean;
  /** Count live (running) entries for `key`. Used by multi-slot prewarm. */
  liveEntryCount(key: string): number;
  /** Diagnostic (optional): why `acquire(key, specHash)` would currently miss,
   *  or "would_hit" if an acquirable entry exists. Computed WITHOUT mutating the
   *  pool, so call it BEFORE acquire (acquire tears down stale candidates).
   *  Optional so diagnostics never break a dispatch on a pool double lacking it. */
  peekMissReason?(key: string, specHash: string): string;
  /** Diagnostic (optional): every key currently holding entries — surfaces key
   *  drift (deposit under key A, acquire under key B → reuse never fires). */
  debugKeys?(): string[];
  /** Oldest idle, unpinned entry timestamp that the registry may evict to make
   *  room under the worker-wide global cap. */
  oldestEvictableIdleAt?(): number | undefined;
  /** Evict the oldest idle, unpinned entry in this pool. */
  evictOldestEvictableIdle?(): boolean;
  /** Oldest idle pinned prewarm entry not belonging to `depositorAgent`. */
  oldestEvictablePrewarmAt?(depositorAgent: string): number | undefined;
  /** Evict the oldest idle pinned prewarm entry not belonging to `depositorAgent`. */
  evictOldestEvictablePrewarm?(depositorAgent: string): AcpWarmPoolPrewarmEviction | null;
  _sweep(): void;
}

export function poolKeyFor(o: { agent: string; cwd: string }): string {
  return `${o.agent}\0${o.cwd}`;
}

export function acpSpecHash(o: {
  binary: string;
  args?: readonly string[];
  model?: string;
}): string {
  return JSON.stringify({
    binary: o.binary,
    args: [...(o.args ?? [])],
    model: o.model ?? null,
  });
}

export interface AcpWarmPoolDeps {
  now?: () => number;
  graceMs?: number;
  maxAgeMs?: number;
  maxEntries?: number;
  maxEntriesPerKey?: number;
  canAddEntry?: (input: AcpWarmPoolCanAddEntryInput) => boolean;
}

interface KeyedRec {
  key: string;
  rec: ShimRec;
}

export interface AcpWarmPoolCanAddEntryInput {
  key: string;
  entry: AcpWarmPoolDeposit;
  onPrewarmEvicted?: (event: AcpWarmPoolPrewarmEviction) => void;
}

interface ShimRec {
  key: string;
  entry: AcpWarmPoolEntry;
  /** Packed spec under which this rec's handle is stored while idle. */
  spec: WarmPoolSpec;
  /** True while the packed pool owns (and supervises) the handle. */
  inPool: boolean;
}

class AcpWarmPoolImpl implements AcpWarmPool {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerKey: number;
  private readonly canAddEntry?: (input: AcpWarmPoolCanAddEntryInput) => boolean;
  private readonly recs = new Map<string, ShimRec[]>();
  private readonly packed: PackedPool;
  private scopeSeq = 0;
  private closed = false;

  constructor(deps: AcpWarmPoolDeps) {
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? 5 * 60_000;
    this.maxAgeMs = deps.maxAgeMs ?? 30 * 60_000;
    this.maxEntries = deps.maxEntries ?? 3;
    this.maxEntriesPerKey = deps.maxEntriesPerKey ?? 1;
    this.canAddEntry = deps.canAddEntry;
    // The packed pool supervises idle handles (liveness probes, exit reapers,
    // teardown); the shim's own _sweep drives eviction cadence, so the packed
    // pool's interval is parked far in the future.
    this.packed = createPackedPool({
      now: this.now,
      sweepIntervalMs: 2_147_483_000,
      graceMs: this.graceMs,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxEntriesPerKey: Number.MAX_SAFE_INTEGER,
    });
  }

  acquire(holderId: string, key: string, specHash: string): AcpWarmPoolEntry | null {
    if (this.closed) return null;
    const list = this.recs.get(key) ?? [];
    for (const rec of [...list]) {
      const entry = rec.entry;
      if (entry.refs.size > 0) continue;
      if (this.now() - entry.spawnedAt > this.maxAgeMs || entry.specHash !== specHash) {
        this.teardown(rec);
        continue;
      }
      const packed = this.packed.acquire(rec.spec);
      if (packed === null) {
        // Packed-side liveness probes found the process dead (or already
        // reaped by a crash hook): the packed teardown already ran.
        entry.tornDown = true;
        this.removeRec(rec);
        continue;
      }
      rec.inPool = false;
      entry.refs.add(holderId);
      entry.lastReleaseAt = undefined;
      return entry;
    }
    return null;
  }

  deposit(
    key: string,
    depositEntry: AcpWarmPoolDeposit,
    opts: AcpWarmPoolDepositOptions = {},
  ): AcpWarmPoolEntry | null {
    if (this.closed) {
      return rejectDeposit(depositEntry, opts);
    }
    if (!this.makeRoomForKey(key)) return rejectDeposit(depositEntry, opts);
    if (!this.makeRoomTotal()) return rejectDeposit(depositEntry, opts);
    if (
      this.canAddEntry &&
      !this.canAddEntry({
        key,
        entry: depositEntry,
        onPrewarmEvicted: opts.onPrewarmEvicted,
      })
    ) {
      return rejectDeposit(depositEntry, opts);
    }

    const entry: AcpWarmPoolEntry = {
      ...depositEntry,
      refs: new Set(),
      spawnedAt: this.now(),
      lastReleaseAt: this.now(),
    };
    const rec: ShimRec = {
      key,
      entry,
      spec: this.packedSpecFor(key, depositEntry),
      inPool: true,
    };
    const packed = this.packed.deposit(
      rec.spec,
      { handle: asPackedHandle(depositEntry.handle), client: depositEntry.client },
      { onReject: opts.onReject },
    );
    if (packed === null) {
      // Packed-side rejection already applied the requested onReject action.
      return null;
    }
    const updated = this.recs.get(key) ?? [];
    updated.push(rec);
    this.recs.set(key, updated);
    void entry.handle.exited.then((code) => {
      if (code !== 0 && entry.refs.size === 0 && !this.closed) {
        console.warn(
          `acp-warm-pool: crashed warm entry teardown key=${key} exit_code=${String(code)}`,
        );
        this.teardown(rec);
      }
    });
    return entry;
  }

  release(holderId: string, key: string): void {
    const list = this.recs.get(key) ?? [];
    for (const rec of list) {
      if (!rec.entry.refs.delete(holderId)) continue;
      if (rec.entry.refs.size === 0) {
        rec.entry.lastReleaseAt = this.now();
        this.depositIdle(rec);
      }
      return;
    }
  }

  evict(key: string, entry?: AcpWarmPoolEntry): void {
    if (entry) {
      const rec = (this.recs.get(key) ?? []).find((candidate) => candidate.entry === entry);
      if (rec) this.teardown(rec);
      return;
    }
    for (const candidate of [...(this.recs.get(key) ?? [])]) {
      this.teardown(candidate);
    }
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [key, list] of [...this.recs]) {
      for (const rec of [...list]) this.teardown(rec);
      this.recs.delete(key);
    }
    this.recs.clear();
    this.packed.shutdown();
  }

  size(): number {
    return this.totalRecs();
  }

  has(key: string): boolean {
    return (this.recs.get(key) ?? []).some((rec) => this.isRunning(rec.entry));
  }

  liveEntryCount(key: string): number {
    return (this.recs.get(key) ?? []).filter((rec) => this.isRunning(rec.entry)).length;
  }

  // Diagnostic mirror of acquire()'s match logic — read-only, no teardown — so a
  // cold dispatch can record WHY it missed before acquire() prunes the evidence.
  peekMissReason(key: string, specHash: string): string {
    const list = this.recs.get(key) ?? [];
    if (list.length === 0) return "no_entry";
    const reasons: string[] = [];
    for (const rec of list) {
      const reason = this.classifyMiss(rec.entry, specHash);
      if (reason === "would_hit") return "would_hit";
      reasons.push(reason);
    }
    return reasons[0] ?? "unknown";
  }

  debugKeys(): string[] {
    return [...this.recs.keys()];
  }

  oldestEvictableIdleAt(): number | undefined {
    const oldest = oldestIdle(this.evictableIdleRecs());
    return oldest ? idleSortAt(oldest.rec.entry) : undefined;
  }

  evictOldestEvictableIdle(): boolean {
    const oldest = oldestIdle(this.evictableIdleRecs());
    if (!oldest) return false;
    this.teardown(oldest.rec);
    return true;
  }

  oldestEvictablePrewarmAt(depositorAgent: string): number | undefined {
    const oldest = oldestIdle(this.evictablePrewarmRecs(depositorAgent));
    return oldest ? idleSortAt(oldest.rec.entry) : undefined;
  }

  evictOldestEvictablePrewarm(depositorAgent: string): AcpWarmPoolPrewarmEviction | null {
    const oldest = oldestIdle(this.evictablePrewarmRecs(depositorAgent));
    if (!oldest) return null;
    const evicted = parsePoolKey(oldest.key);
    const event: AcpWarmPoolPrewarmEviction = {
      evictedAgent: evicted.agent,
      evictedRepoRoot: evicted.repoRoot,
      depositorAgent,
      idleMs: Math.max(0, this.now() - idleSortAt(oldest.rec.entry)),
    };
    this.teardown(oldest.rec);
    return event;
  }

  _sweep(): void {
    this.sweep();
  }

  private packedSpecFor(key: string, dep: AcpWarmPoolDeposit): WarmPoolSpec {
    const parsed = parsePoolKey(key);
    return {
      agent: parsed.agent.length > 0 ? parsed.agent : "agent",
      cwd: parsed.repoRoot.length > 0 ? parsed.repoRoot : process.cwd(),
      credentialScope: `${key}\0${String(this.scopeSeq++)}`,
      specHash: dep.specHash,
      graceMs: this.graceMs,
      pinned: dep.pinned === true,
    };
  }

  private depositIdle(rec: ShimRec): void {
    if (this.closed || rec.inPool) return;
    const packed = this.packed.deposit(rec.spec, {
      handle: asPackedHandle(rec.entry.handle),
      client: rec.entry.client,
    });
    rec.inPool = packed !== null;
    if (packed === null) this.removeRec(rec);
  }

  private classifyMiss(entry: AcpWarmPoolEntry, specHash: string): string {
    if (entry.refs.size > 0) return "in_use";
    if (!this.isRunning(entry)) return "not_running";
    if (this.now() - entry.spawnedAt > this.maxAgeMs) return "aged";
    if (entry.specHash !== specHash) return "spec_mismatch";
    return "would_hit";
  }

  private isRunning(entry: AcpWarmPoolEntry): boolean {
    const handle = entry.handle as StdioAcpHandle & {
      exitCode?: number | null;
      signalCode?: NodeJS.Signals | null;
    };
    const stdout = handle.stdout as StdioAcpHandle["stdout"] & { closed?: boolean };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve compatibility with lightweight clients that omit transport probes.
    const transportOpen = entry.client.isTransportOpen;
    return (
      !entry.tornDown &&
      (handle.exitCode === null || handle.exitCode === undefined) &&
      (handle.signalCode === null || handle.signalCode === undefined) &&
      handle.stdin.writable &&
      Boolean(stdout) &&
      stdout.readable &&
      !stdout.destroyed &&
      !stdout.closed &&
      (typeof transportOpen !== "function" || transportOpen.call(entry.client))
    );
  }

  private removeRec(rec: ShimRec): void {
    const list = this.recs.get(rec.key);
    if (!list) return;
    const next = list.filter((candidate) => candidate !== rec);
    if (next.length === 0) this.recs.delete(rec.key);
    else this.recs.set(rec.key, next);
  }

  private teardown(rec: ShimRec): void {
    this.removeRec(rec);
    if (rec.entry.tornDown === true) return;
    rec.entry.tornDown = true;
    if (rec.inPool) {
      rec.inPool = false;
      this.packed.evict(rec.spec);
      return;
    }
    try {
      rec.entry.handle.kill();
    } catch {
      /* ignore */
    }
  }

  private idleRecsFor(key: string): ShimRec[] {
    return (this.recs.get(key) ?? []).filter((rec) => rec.entry.refs.size === 0);
  }

  private allIdleRecs(): KeyedRec[] {
    const out: KeyedRec[] = [];
    for (const [key, list] of this.recs) {
      for (const rec of list) {
        if (rec.entry.refs.size === 0) out.push({ key, rec });
      }
    }
    return out;
  }

  private evictableIdleRecs(): KeyedRec[] {
    return this.allIdleRecs().filter((candidate) => candidate.rec.entry.pinned !== true);
  }

  private evictablePrewarmRecs(depositorAgent: string): KeyedRec[] {
    return this.allIdleRecs().filter((candidate) => {
      if (candidate.rec.entry.pinned !== true || candidate.rec.entry.prewarm !== true) return false;
      return parsePoolKey(candidate.key).agent !== depositorAgent;
    });
  }

  private totalRecs(): number {
    let total = 0;
    for (const list of this.recs.values()) total += list.length;
    return total;
  }

  private makeRoomForKey(key: string): boolean {
    const list = this.recs.get(key) ?? [];
    if (list.length < this.maxEntriesPerKey) return true;
    const candidates = this.idleRecsFor(key).map((rec): KeyedRec => ({ key, rec }));
    const oldest = oldestIdle(candidates);
    if (!oldest) return false;
    this.teardown(oldest.rec);
    return true;
  }

  private makeRoomTotal(): boolean {
    if (this.totalRecs() < this.maxEntries) return true;
    const oldest = oldestIdle(this.evictableIdleRecs());
    if (!oldest) return false;
    this.teardown(oldest.rec);
    return true;
  }

  private sweep(): void {
    if (this.closed) return;
    const threshold = this.now() - this.graceMs;
    for (const list of [...this.recs.values()]) {
      for (const rec of [...list]) {
        if (!this.isRunning(rec.entry)) {
          this.teardown(rec);
          continue;
        }
        if (rec.entry.refs.size !== 0) continue;
        if (rec.entry.pinned) {
          if (this.now() - rec.entry.spawnedAt > this.maxAgeMs) this.teardown(rec);
          continue;
        }
        if (rec.entry.lastReleaseAt !== undefined && rec.entry.lastReleaseAt <= threshold) {
          this.teardown(rec);
        }
      }
    }
  }
}

function oldestIdle(candidates: KeyedRec[]): KeyedRec | undefined {
  return candidates.sort((a, b) => idleSortAt(a.rec.entry) - idleSortAt(b.rec.entry))[0];
}

function idleSortAt(entry: AcpWarmPoolEntry): number {
  return entry.lastReleaseAt ?? entry.spawnedAt;
}

function parsePoolKey(key: string): { agent: string; repoRoot: string } {
  const separator = key.indexOf("\0");
  if (separator === -1) return { agent: key, repoRoot: "" };
  return { agent: key.slice(0, separator), repoRoot: key.slice(separator + 1) };
}

function rejectDeposit(entry: AcpWarmPoolDeposit, opts: AcpWarmPoolDepositOptions = {}): null {
  if ((opts.onReject ?? "kill") === "kill") {
    try {
      entry.handle.kill();
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function createAcpWarmPool(deps: AcpWarmPoolDeps = {}): AcpWarmPool {
  return new AcpWarmPoolImpl(deps);
}
