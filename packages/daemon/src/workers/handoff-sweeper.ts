// Handoff sweeper worker - periodic TTL-based handoff cleanup.
// The memory-verify auto-fire path that previously lived here was removed in 2026-05-18.
import type { Services } from "@penumbra/core";

import {
  MIN_DISPATCHED_TTL_MS,
  resolveDispatchedTtlMs,
  resolvePendingTtlMs,
} from "./handoff-sweeper-thresholds.js";

export interface HandoffSweeperOpts {
  services: Services;
  pendingTtlMs?: number;
  dispatchedTtlMs?: number;
}

export interface HandoffSweeperWorker {
  tick(): Promise<void>;
}

type CandidateRow = { handoff_id: string; ts: string; chain_task_type: string | null };

function parseEnvInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createHandoffSweeperWorker(opts: HandoffSweeperOpts): HandoffSweeperWorker {
  return {
    tick(): Promise<void> {
      try {
        const pendingTtlMs =
          opts.pendingTtlMs ??
          parseEnvInt(process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS) ??
          resolvePendingTtlMs();

        // null = use per-task-class thresholds; number = flat global override.
        const globalDispatchedOverride: number | null =
          opts.dispatchedTtlMs ?? parseEnvInt(process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS);

        const now = new Date(opts.services.clock());
        const nowIso = now.toISOString();

        // --- pending: flat TTL, unchanged behaviour ---
        const pendingThreshold = new Date(now.getTime() - pendingTtlMs).toISOString();
        const expirePending = opts.services.db.transaction(() => {
          return opts.services.handoffWriter.expirePendingOlderThan({
            olderThanIso: pendingThreshold,
            ts: nowIso,
            reason: `expired by sweeper after ${String(pendingTtlMs)}ms in pending`,
          });
        });

        // --- dispatched: event-aware + per-task-class TTL ---
        // Load every dispatched row older than the smallest possible threshold so we
        // can apply per-row TTL in TypeScript without a full-table scan each time.
        const sqlCutoffMs = globalDispatchedOverride ?? MIN_DISPATCHED_TTL_MS;
        const sqlCutoff = new Date(now.getTime() - sqlCutoffMs).toISOString();

        const candidates = opts.services.db
          .query<
            CandidateRow,
            [string]
          >(`SELECT handoff_id, ts, chain_task_type FROM handoffs WHERE status = 'dispatched' AND ts < ?`)
          .all(sqlCutoff);

        const toExpire: {
          handoff_id: string;
          ttlMs: number;
          chain_task_type: string | null;
        }[] = [];
        for (const row of candidates) {
          const effectiveTtlMs =
            globalDispatchedOverride ?? resolveDispatchedTtlMs(row.chain_task_type);
          const threshold = new Date(now.getTime() - effectiveTtlMs).toISOString();

          // Not old enough by per-row TTL — skip.
          if (row.ts >= threshold) continue;

          toExpire.push({
            handoff_id: row.handoff_id,
            ttlMs: effectiveTtlMs,
            chain_task_type: row.chain_task_type,
          });
        }

        const expireDispatched = opts.services.db.transaction(() => {
          if (toExpire.length === 0) return 0;
          let changes = 0;
          for (const { handoff_id, ttlMs, chain_task_type } of toExpire) {
            const suffix = chain_task_type ? ` (task_type=${chain_task_type})` : "";
            const threshold = new Date(now.getTime() - ttlMs).toISOString();
            if (
              opts.services.handoffWriter.expireDispatchedIdle(handoff_id, {
                ts: nowIso,
                reason: `expired by sweeper after ${String(ttlMs)}ms in dispatched${suffix}`,
                activitySinceIso: threshold,
              })
            ) {
              changes += 1;
            }
          }
          return changes;
        });

        const count = expirePending() + expireDispatched();
        if (count > 0) {
          opts.services.log.info({ count }, "handoff sweeper: marked stuck handoffs as expired");
        }
      } catch (err) {
        opts.services.log.error({ err }, "handoff sweeper: failed to sweep handoffs");
      }
      return Promise.resolve();
    },
  };
}
