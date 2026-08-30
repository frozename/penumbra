import type { StdioAcpClient } from "./stdio-acp-client.js";
import type { StdioAcpHandle } from "./stdio-acp-server.js";

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

interface KeyedEntry {
  key: string;
  entry: AcpWarmPoolEntry;
}

export interface AcpWarmPoolCanAddEntryInput {
  key: string;
  entry: AcpWarmPoolDeposit;
  onPrewarmEvicted?: (event: AcpWarmPoolPrewarmEviction) => void;
}

class AcpWarmPoolImpl implements AcpWarmPool {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerKey: number;
  private readonly canAddEntry?: (input: AcpWarmPoolCanAddEntryInput) => boolean;
  private readonly entries = new Map<string, AcpWarmPoolEntry[]>();
  private readonly sweepTimer: NodeJS.Timeout;
  private closed = false;

  constructor(deps: AcpWarmPoolDeps) {
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? 5 * 60_000;
    this.maxAgeMs = deps.maxAgeMs ?? 30 * 60_000;
    this.maxEntries = deps.maxEntries ?? 3;
    this.maxEntriesPerKey = deps.maxEntriesPerKey ?? 1;
    this.canAddEntry = deps.canAddEntry;
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, 60_000);
    this.sweepTimer.unref();
  }

  acquire(holderId: string, key: string, specHash: string): AcpWarmPoolEntry | null {
    if (this.closed) return null;
    const list = this.entries.get(key) ?? [];
    for (const entry of [...list]) {
      if (entry.refs.size > 0) continue;
      if (
        !this.isRunning(entry) ||
        this.now() - entry.spawnedAt > this.maxAgeMs ||
        entry.specHash !== specHash
      ) {
        this.teardown(key, entry);
        continue;
      }
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
    const updated = this.entries.get(key) ?? [];
    updated.push(entry);
    this.entries.set(key, updated);
    void entry.handle.exited.then((code) => {
      if (code !== 0 && entry.refs.size === 0) {
        // Surface warm-pool crash-reaps: paired with stdio-acp-server's spawn
        // error log, this makes crash-loops visible instead of silently
        // tearing down and rewarming.
        console.warn(
          `acp-warm-pool: crashed warm entry teardown key=${key} exit_code=${String(code)}`,
        );
        this.teardown(key, entry);
      }
    });
    return entry;
  }

  release(holderId: string, key: string): void {
    const list = this.entries.get(key) ?? [];
    for (const entry of list) {
      if (!entry.refs.delete(holderId)) continue;
      if (entry.refs.size === 0) entry.lastReleaseAt = this.now();
      return;
    }
  }

  evict(key: string, entry?: AcpWarmPoolEntry): void {
    if (entry) {
      this.teardown(key, entry);
      return;
    }
    for (const candidate of [...(this.entries.get(key) ?? [])]) {
      this.teardown(key, candidate);
    }
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    for (const [key, list] of [...this.entries]) {
      for (const entry of [...list]) this.teardown(key, entry);
    }
    this.entries.clear();
  }

  size(): number {
    return this.totalEntries();
  }

  has(key: string): boolean {
    return (this.entries.get(key) ?? []).some((entry) => this.isRunning(entry));
  }

  liveEntryCount(key: string): number {
    return (this.entries.get(key) ?? []).filter((entry) => this.isRunning(entry)).length;
  }

  // Diagnostic mirror of acquire()'s match logic — read-only, no teardown — so a
  // cold dispatch can record WHY it missed before acquire() prunes the evidence.
  peekMissReason(key: string, specHash: string): string {
    const list = this.entries.get(key) ?? [];
    if (list.length === 0) return "no_entry";
    const reasons: string[] = [];
    for (const entry of list) {
      const reason = this.classifyMiss(entry, specHash);
      if (reason === "would_hit") return "would_hit";
      reasons.push(reason);
    }
    return reasons[0] ?? "unknown";
  }

  debugKeys(): string[] {
    return [...this.entries.keys()];
  }

  oldestEvictableIdleAt(): number | undefined {
    const oldest = oldestIdle(this.evictableIdleEntries());
    return oldest ? idleSortAt(oldest.entry) : undefined;
  }

  evictOldestEvictableIdle(): boolean {
    const oldest = oldestIdle(this.evictableIdleEntries());
    if (!oldest) return false;
    this.teardown(oldest.key, oldest.entry);
    return true;
  }

  oldestEvictablePrewarmAt(depositorAgent: string): number | undefined {
    const oldest = oldestIdle(this.evictablePrewarmEntries(depositorAgent));
    return oldest ? idleSortAt(oldest.entry) : undefined;
  }

  evictOldestEvictablePrewarm(depositorAgent: string): AcpWarmPoolPrewarmEviction | null {
    const oldest = oldestIdle(this.evictablePrewarmEntries(depositorAgent));
    if (!oldest) return null;
    const evicted = parsePoolKey(oldest.key);
    const event: AcpWarmPoolPrewarmEviction = {
      evictedAgent: evicted.agent,
      evictedRepoRoot: evicted.repoRoot,
      depositorAgent,
      idleMs: Math.max(0, this.now() - idleSortAt(oldest.entry)),
    };
    this.teardown(oldest.key, oldest.entry);
    return event;
  }

  _sweep(): void {
    this.sweep();
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
    const transportOpen = entry.client.isTransportOpen();
    return (
      !entry.tornDown &&
      (handle.exitCode === null || handle.exitCode === undefined) &&
      (handle.signalCode === null || handle.signalCode === undefined) &&
      handle.stdin.writable &&
      Boolean(stdout) &&
      stdout.readable &&
      !stdout.destroyed &&
      !stdout.closed &&
      transportOpen
    );
  }

  private removeEntry(key: string, entry: AcpWarmPoolEntry): void {
    const list = this.entries.get(key);
    if (!list) return;
    const next = list.filter((candidate) => candidate !== entry);
    if (next.length === 0) this.entries.delete(key);
    else this.entries.set(key, next);
  }

  private teardown(key: string, entry: AcpWarmPoolEntry): void {
    this.removeEntry(key, entry);
    if (entry.tornDown) return;
    entry.tornDown = true;
    try {
      entry.handle.kill();
    } catch {
      /* ignore */
    }
  }

  private idleEntriesFor(key: string): AcpWarmPoolEntry[] {
    return (this.entries.get(key) ?? []).filter((entry) => entry.refs.size === 0);
  }

  private allIdleEntries(): KeyedEntry[] {
    const out: KeyedEntry[] = [];
    for (const [key, list] of this.entries) {
      for (const entry of list) {
        if (entry.refs.size === 0) out.push({ key, entry });
      }
    }
    return out;
  }

  private evictableIdleEntries(): KeyedEntry[] {
    return this.allIdleEntries().filter((candidate) => candidate.entry.pinned !== true);
  }

  private evictablePrewarmEntries(depositorAgent: string): KeyedEntry[] {
    return this.allIdleEntries().filter((candidate) => {
      if (candidate.entry.pinned !== true || candidate.entry.prewarm !== true) return false;
      return parsePoolKey(candidate.key).agent !== depositorAgent;
    });
  }

  private totalEntries(): number {
    let total = 0;
    for (const list of this.entries.values()) total += list.length;
    return total;
  }

  private makeRoomForKey(key: string): boolean {
    const list = this.entries.get(key) ?? [];
    if (list.length < this.maxEntriesPerKey) return true;
    const candidates = this.idleEntriesFor(key).map((entry): KeyedEntry => ({ key, entry }));
    const oldest = oldestIdle(candidates);
    if (!oldest) return false;
    this.teardown(oldest.key, oldest.entry);
    return true;
  }

  private makeRoomTotal(): boolean {
    if (this.totalEntries() < this.maxEntries) return true;
    const oldest = oldestIdle(this.evictableIdleEntries());
    if (!oldest) return false;
    this.teardown(oldest.key, oldest.entry);
    return true;
  }

  private sweep(): void {
    if (this.closed) return;
    const threshold = this.now() - this.graceMs;
    for (const [key, list] of [...this.entries]) {
      for (const entry of [...list]) this.sweepEntry(key, entry, threshold);
    }
  }

  private sweepEntry(key: string, entry: AcpWarmPoolEntry, threshold: number): void {
    if (!this.isRunning(entry)) {
      this.teardown(key, entry);
      return;
    }
    if (entry.refs.size !== 0) return;
    if (entry.pinned) {
      // Pre-warmed connections are kept warm deliberately: skip the
      // idle-grace teardown, but reap once past max-age so a stale pinned
      // entry can't outlive its spec (the pre-warm loop re-warms a fresh one).
      if (this.now() - entry.spawnedAt > this.maxAgeMs) this.teardown(key, entry);
      return;
    }
    if (entry.lastReleaseAt !== undefined && entry.lastReleaseAt <= threshold) {
      this.teardown(key, entry);
    }
  }
}

function oldestIdle(candidates: KeyedEntry[]): KeyedEntry | undefined {
  return candidates.sort((a, b) => idleSortAt(a.entry) - idleSortAt(b.entry))[0];
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
