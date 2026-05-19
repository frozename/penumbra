// Handoff sweeper worker - periodic TTL-based handoff cleanup.
// The memory-verify auto-fire path that previously lived here was removed in 2026-05-18; see docs/specs/2026-05-17-memory-verify-authz-decouple.md.
import type { Services } from '@penumbra/core';
import { resolveDispatchedTtlMs, resolvePendingTtlMs, MIN_DISPATCHED_TTL_MS } from './handoff-sweeper-thresholds.js';

export interface HandoffSweeperOpts {
  services: Services;
  pendingTtlMs?: number;
  dispatchedTtlMs?: number;
}

type CandidateRow = { handoff_id: string; ts: string; chain_task_type: string | null };

export function createHandoffSweeperWorker(opts: HandoffSweeperOpts) {
  return {
    async tick(): Promise<void> {
      try {
        const pendingTtlMs =
          opts.pendingTtlMs ??
          (process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS
            ? parseInt(process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS, 10)
            : resolvePendingTtlMs());

        // null = use per-task-class thresholds; number = flat global override.
        const globalDispatchedOverride: number | null =
          opts.dispatchedTtlMs != null
            ? opts.dispatchedTtlMs
            : process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS
              ? parseInt(process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS, 10)
              : null;

        const now = new Date(opts.services.clock());
        const nowIso = now.toISOString();

        // --- pending: flat TTL, unchanged behaviour ---
        const pendingThreshold = new Date(now.getTime() - pendingTtlMs).toISOString();
        const expirePending = opts.services.db.transaction(() => {
          const stmt = opts.services.db.query(`
            UPDATE handoffs
            SET
              status = 'expired',
              resolved_at = ?1,
              resolution_reason = ?2
            WHERE status = 'pending' AND ts < ?3
          `);
          return stmt.run(
            nowIso,
            `expired by sweeper after ${pendingTtlMs}ms in pending`,
            pendingThreshold,
          ).changes;
        });

        // --- dispatched: event-aware + per-task-class TTL ---
        // Load every dispatched row older than the smallest possible threshold so we
        // can apply per-row TTL in TypeScript without a full-table scan each time.
        const sqlCutoffMs = globalDispatchedOverride ?? MIN_DISPATCHED_TTL_MS;
        const sqlCutoff = new Date(now.getTime() - sqlCutoffMs).toISOString();

        const candidates = opts.services.db
          .query<CandidateRow, [string]>(
            `SELECT handoff_id, ts, chain_task_type FROM handoffs WHERE status = 'dispatched' AND ts < ?`,
          )
          .all(sqlCutoff);

        const activityQuery = opts.services.db.query<{ found: 1 }, [string, string]>(
          `SELECT 1 AS found FROM dispatch_events WHERE handoff_id = ? AND ts >= ? LIMIT 1`,
        );

        const toExpire: Array<{ handoff_id: string; ttlMs: number; chain_task_type: string | null }> = [];
        for (const row of candidates) {
          const effectiveTtlMs =
            globalDispatchedOverride ?? resolveDispatchedTtlMs(row.chain_task_type);
          const threshold = new Date(now.getTime() - effectiveTtlMs).toISOString();

          // Not old enough by per-row TTL — skip.
          if (row.ts >= threshold) continue;

          // Has recent dispatch_events activity within the same window — still live.
          const recentEvent = activityQuery.get(row.handoff_id, threshold);
          if (recentEvent) continue;

          toExpire.push({ handoff_id: row.handoff_id, ttlMs: effectiveTtlMs, chain_task_type: row.chain_task_type });
        }

        const expireDispatched = opts.services.db.transaction(() => {
          if (toExpire.length === 0) return 0;
          const stmt = opts.services.db.query(
            `UPDATE handoffs SET status = 'expired', resolved_at = ?1, resolution_reason = ?2 WHERE handoff_id = ?3 AND status = 'dispatched'`,
          );
          for (const { handoff_id, ttlMs, chain_task_type } of toExpire) {
            const suffix = chain_task_type ? ` (task_type=${chain_task_type})` : '';
            stmt.run(nowIso, `expired by sweeper after ${ttlMs}ms in dispatched${suffix}`, handoff_id);
          }
          return toExpire.length;
        });

        const count = expirePending() + expireDispatched();
        if (count > 0) {
          opts.services.log.info({ count }, 'handoff sweeper: marked stuck handoffs as expired');
        }
      } catch (err) {
        opts.services.log.error({ err }, 'handoff sweeper: failed to sweep handoffs');
      }
    },
  };
}
