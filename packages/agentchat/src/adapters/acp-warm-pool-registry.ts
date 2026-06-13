import { createAcpWarmPool, type AcpWarmPool } from "./acp-warm-pool.js";

export interface AcpWarmPoolRegistryOptions {
  warmPoolIdleGraceMs?: number;
  warmPoolMaxAgeMs?: number;
  warmPoolMaxEntries?: number;
  warmPoolSize?: number;
}

const pools = new Map<string, AcpWarmPool>();
const DEFAULT_WARM_PREWARM_CAP = 4;

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveMaxEntries(opts: AcpWarmPoolRegistryOptions): number | undefined {
  const envCap = positiveInt(process.env.PENUMBRA_WARM_PREWARM_CAP) ?? DEFAULT_WARM_PREWARM_CAP;
  if (opts.warmPoolMaxEntries !== undefined && envCap !== undefined) {
    return Math.min(opts.warmPoolMaxEntries, envCap);
  }
  return opts.warmPoolMaxEntries ?? envCap;
}

export function getOrCreateAcpWarmPool(
  agent: string,
  opts: AcpWarmPoolRegistryOptions,
): AcpWarmPool {
  const existing = pools.get(agent);
  if (existing) return existing;
  const envCap = positiveInt(process.env.PENUMBRA_WARM_PREWARM_CAP) ?? DEFAULT_WARM_PREWARM_CAP;
  const pool = createAcpWarmPool({
    graceMs: opts.warmPoolIdleGraceMs,
    maxAgeMs: opts.warmPoolMaxAgeMs,
    maxEntries: resolveMaxEntries(opts),
    maxEntriesPerKey: opts.warmPoolSize,
    canAddEntry: () => totalAcpWarmPoolEntryCount() < envCap,
  });
  pools.set(agent, pool);
  return pool;
}

export function drainAgent(agent: string): void {
  const pool = pools.get(agent);
  if (!pool) return;
  pool.shutdown();
  pools.delete(agent);
}

export function shutdownAllAcpWarmPools(): void {
  for (const pool of pools.values()) {
    pool.shutdown();
  }
  pools.clear();
}

/**
 * Total warm entries (live ACP processes) across every agent pool on this
 * worker. The pre-warm loop (Phase 4) reads this as the worker-level cost
 * ceiling so eager pre-warming can never push the idle-process footprint above
 * the cap — including processes deposited lazily by cold dispatches, not just
 * pre-warmed ones.
 */
export function totalAcpWarmPoolEntryCount(): number {
  let total = 0;
  for (const pool of pools.values()) total += pool.size();
  return total;
}

/**
 * True if a live warm entry already exists for `(agent, key)`. Peek-only — does
 * NOT create a pool (unlike getOrCreateAcpWarmPool) — so the pre-warm loop can
 * cheaply decide whether a target needs (re)warming, self-healing a crashed
 * pre-warm without waiting for the next refresh tick.
 */
export function acpWarmPoolHasLiveEntry(agent: string, key: string): boolean {
  const pool = pools.get(agent);
  return pool ? pool.has(key) : false;
}

export function acpWarmPoolLiveEntryCount(agent: string, key: string): number {
  const pool = pools.get(agent);
  return pool ? pool.liveEntryCount(key) : 0;
}

export function resetAcpWarmPoolRegistryForTest(): void {
  shutdownAllAcpWarmPools();
}
