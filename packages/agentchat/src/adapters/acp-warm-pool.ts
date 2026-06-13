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

export function createAcpWarmPool(
  deps: {
    now?: () => number;
    graceMs?: number;
    maxAgeMs?: number;
    maxEntries?: number;
    maxEntriesPerKey?: number;
    canAddEntry?: () => boolean;
  } = {},
): AcpWarmPool {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? 5 * 60_000;
  const maxAgeMs = deps.maxAgeMs ?? 30 * 60_000;
  const maxEntries = deps.maxEntries ?? 3;
  const maxEntriesPerKey = deps.maxEntriesPerKey ?? 1;
  const entries = new Map<string, AcpWarmPoolEntry[]>();
  let closed = false;
  const sweepTimer = setInterval(() => {
    sweep();
  }, 60_000);
  sweepTimer.unref?.();

  function isRunning(entry: AcpWarmPoolEntry): boolean {
    const handle = entry.handle as StdioAcpHandle & {
      exitCode?: number | null;
      signalCode?: NodeJS.Signals | null;
    };
    return (
      !entry.tornDown &&
      handle.exitCode == null &&
      handle.signalCode == null &&
      Boolean(handle.stdin?.writable)
    );
  }

  function removeEntry(key: string, entry: AcpWarmPoolEntry): void {
    const list = entries.get(key);
    if (!list) return;
    const next = list.filter((candidate) => candidate !== entry);
    if (next.length === 0) entries.delete(key);
    else entries.set(key, next);
  }

  function teardown(key: string, entry: AcpWarmPoolEntry): void {
    removeEntry(key, entry);
    if (entry.tornDown) return;
    entry.tornDown = true;
    try {
      entry.handle.kill();
    } catch {
      /* ignore */
    }
  }

  function idleEntriesFor(key: string): AcpWarmPoolEntry[] {
    return (entries.get(key) ?? []).filter((entry) => entry.refs.size === 0);
  }

  function allIdleEntries(): Array<{ key: string; entry: AcpWarmPoolEntry }> {
    const out: Array<{ key: string; entry: AcpWarmPoolEntry }> = [];
    for (const [key, list] of entries) {
      for (const entry of list) {
        if (entry.refs.size === 0) out.push({ key, entry });
      }
    }
    return out;
  }

  function oldestIdle(
    candidates: Array<{ key: string; entry: AcpWarmPoolEntry }>,
  ): { key: string; entry: AcpWarmPoolEntry } | undefined {
    return candidates.sort(
      (a, b) =>
        (a.entry.lastReleaseAt ?? a.entry.spawnedAt) - (b.entry.lastReleaseAt ?? b.entry.spawnedAt),
    )[0];
  }

  function totalEntries(): number {
    let total = 0;
    for (const list of entries.values()) total += list.length;
    return total;
  }

  function rejectDeposit(entry: AcpWarmPoolDeposit): null {
    try {
      entry.handle.kill();
    } catch {
      /* ignore */
    }
    return null;
  }

  function sweep(): void {
    if (closed) return;
    const threshold = now() - graceMs;
    for (const [key, list] of [...entries]) {
      for (const entry of [...list]) {
        if (!isRunning(entry)) {
          teardown(key, entry);
          continue;
        }
        if (entry.refs.size !== 0) continue;
        if (entry.pinned) {
          // Pre-warmed connections are kept warm deliberately: skip the
          // idle-grace teardown, but reap once past max-age so a stale pinned
          // entry can't outlive its spec (the pre-warm loop re-warms a fresh one).
          if (now() - entry.spawnedAt > maxAgeMs) teardown(key, entry);
          continue;
        }
        if (entry.lastReleaseAt !== undefined && entry.lastReleaseAt <= threshold) {
          teardown(key, entry);
        }
      }
    }
  }

  function acquire(holderId: string, key: string, specHash: string): AcpWarmPoolEntry | null {
    if (closed) return null;
    const list = entries.get(key) ?? [];
    for (const entry of [...list]) {
      if (entry.refs.size > 0) continue;
      if (!isRunning(entry) || now() - entry.spawnedAt > maxAgeMs || entry.specHash !== specHash) {
        teardown(key, entry);
        continue;
      }
      entry.refs.add(holderId);
      entry.lastReleaseAt = undefined;
      return entry;
    }
    return null;
  }

  function deposit(key: string, depositEntry: AcpWarmPoolDeposit): AcpWarmPoolEntry | null {
    if (closed) {
      return rejectDeposit(depositEntry);
    }
    const list = entries.get(key) ?? [];
    if (list.length >= maxEntriesPerKey) {
      const oldest = oldestIdle(idleEntriesFor(key).map((entry) => ({ key, entry })));
      if (!oldest) return rejectDeposit(depositEntry);
      teardown(oldest.key, oldest.entry);
    }
    if (totalEntries() >= maxEntries) {
      const oldest = oldestIdle(allIdleEntries());
      if (!oldest) return rejectDeposit(depositEntry);
      teardown(oldest.key, oldest.entry);
    }
    if (deps.canAddEntry && !deps.canAddEntry()) return rejectDeposit(depositEntry);
    const entry: AcpWarmPoolEntry = {
      ...depositEntry,
      refs: new Set(),
      spawnedAt: now(),
      lastReleaseAt: now(),
    };
    const updated = entries.get(key) ?? [];
    updated.push(entry);
    entries.set(key, updated);
    entry.handle.exited.then((code) => {
      if (code !== 0 && entry.refs.size === 0) teardown(key, entry);
    });
    return entry;
  }

  function release(holderId: string, key: string): void {
    const list = entries.get(key) ?? [];
    for (const entry of list) {
      if (!entry.refs.delete(holderId)) continue;
      if (entry.refs.size === 0) entry.lastReleaseAt = now();
      return;
    }
  }

  function evict(key: string, entry?: AcpWarmPoolEntry): void {
    if (entry) {
      teardown(key, entry);
      return;
    }
    for (const candidate of [...(entries.get(key) ?? [])]) {
      teardown(key, candidate);
    }
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
    for (const [key, list] of [...entries]) {
      for (const entry of [...list]) teardown(key, entry);
    }
    entries.clear();
  }

  function size(): number {
    return totalEntries();
  }

  function has(key: string): boolean {
    return (entries.get(key) ?? []).some((entry) => isRunning(entry));
  }

  function liveEntryCount(key: string): number {
    return (entries.get(key) ?? []).filter((entry) => isRunning(entry)).length;
  }

  // Diagnostic mirror of acquire()'s match logic — read-only, no teardown — so a
  // cold dispatch can record WHY it missed before acquire() prunes the evidence.
  function peekMissReason(key: string, specHash: string): string {
    const list = entries.get(key) ?? [];
    if (list.length === 0) return "no_entry";
    const reasons: string[] = [];
    for (const entry of list) {
      if (entry.refs.size > 0) {
        reasons.push("in_use");
      } else if (!isRunning(entry)) {
        reasons.push("not_running");
      } else if (now() - entry.spawnedAt > maxAgeMs) {
        reasons.push("aged");
      } else if (entry.specHash !== specHash) {
        reasons.push("spec_mismatch");
      } else {
        return "would_hit";
      }
    }
    return reasons[0] ?? "unknown";
  }

  function debugKeys(): string[] {
    return [...entries.keys()];
  }

  return {
    acquire,
    deposit,
    release,
    evict,
    shutdown,
    size,
    has,
    liveEntryCount,
    peekMissReason,
    debugKeys,
    _sweep: sweep,
  };
}
