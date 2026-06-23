import type { StdioAcpClient } from "./stdio-acp-client.js";
import type { StdioAcpHandle } from "./stdio-acp-server.js";

export interface AcpWarmPoolEntry {
  handle: StdioAcpHandle;
  client: StdioAcpClient;
  /**
   * Vestigial. Under the connection-pool model (Option B) the pool holds a warm
   * process + initialized/authenticated client, NOT a session — each dispatch
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
}

export interface AcpWarmPoolDeposit {
  handle: StdioAcpHandle;
  client: StdioAcpClient;
  sessionId?: string;
  specHash: string;
  pinned?: boolean;
}

export interface AcpWarmPool {
  acquire(holderId: string, key: string, specHash: string): AcpWarmPoolEntry | null;
  deposit(key: string, entry: AcpWarmPoolDeposit): AcpWarmPoolEntry | null;
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
  canAddEntry?: () => boolean;
}

interface KeyedEntry {
  key: string;
  entry: AcpWarmPoolEntry;
}

class AcpWarmPoolImpl implements AcpWarmPool {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerKey: number;
  private readonly canAddEntry?: () => boolean;
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

  deposit(key: string, depositEntry: AcpWarmPoolDeposit): AcpWarmPoolEntry | null {
    if (this.closed) {
      return rejectDeposit(depositEntry);
    }
    if (!this.makeRoomForKey(key)) return rejectDeposit(depositEntry);
    if (!this.makeRoomTotal()) return rejectDeposit(depositEntry);
    if (this.canAddEntry && !this.canAddEntry()) return rejectDeposit(depositEntry);

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
      if (code !== 0 && entry.refs.size === 0) this.teardown(key, entry);
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
    return (
      !entry.tornDown &&
      (handle.exitCode === null || handle.exitCode === undefined) &&
      (handle.signalCode === null || handle.signalCode === undefined) &&
      handle.stdin.writable &&
      Boolean(stdout) &&
      stdout.readable &&
      !stdout.destroyed &&
      !stdout.closed
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
    const oldest = oldestIdle(this.allIdleEntries());
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
  return candidates.sort(
    (a, b) =>
      (a.entry.lastReleaseAt ?? a.entry.spawnedAt) - (b.entry.lastReleaseAt ?? b.entry.spawnedAt),
  )[0];
}

function rejectDeposit(entry: AcpWarmPoolDeposit): null {
  try {
    entry.handle.kill();
  } catch {
    /* ignore */
  }
  return null;
}

export function createAcpWarmPool(deps: AcpWarmPoolDeps = {}): AcpWarmPool {
  return new AcpWarmPoolImpl(deps);
}
