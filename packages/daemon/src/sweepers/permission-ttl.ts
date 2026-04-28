import type { Services } from '@penumbra/core';

/**
 * Atomic CAS sweep: pending rows whose ttl_at <= now → expired. Emits one
 * permission.expired event per transitioned row + writes a t0 audit event.
 * Returns the count of rows transitioned.
 *
 * Idempotent — concurrent calls compete via SQL UPDATE WHERE; only one wins
 * each row. Safe to run alongside per-row setTimeout TTL fires (also CAS).
 */
export function runPermissionTtlSweep(services: Services): number {
  const now_iso = services.clock().toISOString();
  // Snapshot the candidates BEFORE the UPDATE so we know which ids transitioned.
  const candidates = services.permissionReader.listByStatus({ statuses: ['pending'] })
    .filter((row) => row.ttl_at <= now_iso);
  if (candidates.length === 0) return 0;

  const transitioned = services.permissionWriter.expirePastDue(now_iso);
  if (transitioned === 0) return 0;

  // Re-read the rows we attempted to expire; only emit for ones now 'expired'.
  for (const candidate of candidates) {
    const row = services.permissionReader.get(candidate.permission_id);
    if (!row || row.status !== 'expired') continue;
    services.permissionEvents.emit({
      kind: 'permission.expired',
      permission_id: row.permission_id,
      ts: now_iso,
      payload: {
        permission_id: row.permission_id,
        ttl_at: row.ttl_at,
        expired_at: now_iso,
      },
    });
    services.t0Writer.write({
      event_id: services.uuid(),
      ts: now_iso,
      ingest_ts: now_iso,
      source: 'mcp',
      source_detail: 'permission-audit',
      project_id: null,
      user_id: services.machineId.get(),
      machine_id: services.machineId.get(),
      session_id: row.conversation_id,
      event_type: 'permission-expired',
      lane: 'unknown',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: { permission_id: row.permission_id, ttl_at: row.ttl_at },
      payload_summary: `permission ${row.permission_id} expired`,
    });
  }
  return transitioned;
}

/** Schedules the sweep on a recurring interval. Returns a cancel function. */
export function startPermissionTtlSweeper(services: Services, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    try { runPermissionTtlSweep(services); }
    catch (err) { (services as any).log?.warn?.({ err: String(err) }, 'permission-ttl sweep failed'); }
  }, intervalMs);
  // Don't keep the process alive just for this timer.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
