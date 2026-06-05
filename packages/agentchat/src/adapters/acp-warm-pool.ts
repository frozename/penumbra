import type { StdioAcpClient } from "./stdio-acp-client.js";
import type { StdioAcpHandle } from "./stdio-acp-server.js";

export interface AcpWarmPoolEntry {
  handle: StdioAcpHandle;
  client: StdioAcpClient;
  sessionId: string;
  refs: Set<string>;
  lastReleaseAt?: number;
  spawnedAt: number;
  specHash: string;
  tornDown?: boolean;
}

export interface AcpWarmPoolDeposit {
  handle: StdioAcpHandle;
  client: StdioAcpClient;
  sessionId: string;
  specHash: string;
}

export interface AcpWarmPool {
  acquire(holderId: string, key: string, specHash: string): AcpWarmPoolEntry | null;
  deposit(key: string, entry: AcpWarmPoolDeposit): AcpWarmPoolEntry | null;
  release(holderId: string, key: string): void;
  evict(key: string, entry?: AcpWarmPoolEntry): void;
  shutdown(): void;
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
  } = {},
): AcpWarmPool {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? 5 * 60_000;
  const maxAgeMs = deps.maxAgeMs ?? 30 * 60_000;
  const maxEntries = deps.maxEntries ?? 3;
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

  function sweep(): void {
    if (closed) return;
    const threshold = now() - graceMs;
    for (const [key, list] of [...entries]) {
      for (const entry of [...list]) {
        if (!isRunning(entry)) {
          teardown(key, entry);
          continue;
        }
        if (
          entry.refs.size === 0 &&
          entry.lastReleaseAt !== undefined &&
          entry.lastReleaseAt <= threshold
        ) {
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
      try {
        depositEntry.handle.kill();
      } catch {
        /* ignore */
      }
      return null;
    }
    const list = entries.get(key) ?? [];
    if (list.length >= maxEntries) {
      const oldest = idleEntriesFor(key).sort(
        (a, b) => (a.lastReleaseAt ?? a.spawnedAt) - (b.lastReleaseAt ?? b.spawnedAt),
      )[0];
      if (!oldest) return null;
      teardown(key, oldest);
    }
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

  return {
    acquire,
    deposit,
    release,
    evict,
    shutdown,
    _sweep: sweep,
  };
}
