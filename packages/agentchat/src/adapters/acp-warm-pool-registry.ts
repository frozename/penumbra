import { createAcpWarmPool, type AcpWarmPool } from "./acp-warm-pool.js";

export interface AcpWarmPoolRegistryOptions {
  warmPoolIdleGraceMs?: number;
  warmPoolMaxAgeMs?: number;
  warmPoolMaxEntries?: number;
}

const pools = new Map<string, AcpWarmPool>();

export function getOrCreateAcpWarmPool(
  agent: string,
  opts: AcpWarmPoolRegistryOptions,
): AcpWarmPool {
  const existing = pools.get(agent);
  if (existing) return existing;
  const pool = createAcpWarmPool({
    graceMs: opts.warmPoolIdleGraceMs,
    maxAgeMs: opts.warmPoolMaxAgeMs,
    maxEntries: opts.warmPoolMaxEntries,
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

export function resetAcpWarmPoolRegistryForTest(): void {
  shutdownAllAcpWarmPools();
}
