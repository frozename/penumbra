import type { Services } from '@penumbra/core';

export interface HandoffSweeperOpts {
  services: Services;
  pendingTtlMs?: number;
  dispatchedTtlMs?: number;
}

export function createHandoffSweeperWorker(opts: HandoffSweeperOpts) {
  return {
    async tick(): Promise<void> {
      try {
        const pendingTtlMs = opts.pendingTtlMs ?? (process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS ? parseInt(process.env.PENUMBRA_HANDOFF_PENDING_TTL_MS, 10) : 3600000);
        const dispatchedTtlMs = opts.dispatchedTtlMs ?? (process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS ? parseInt(process.env.PENUMBRA_HANDOFF_DISPATCHED_TTL_MS, 10) : 1800000);

        const now = new Date(opts.services.clock());
        const nowIso = now.toISOString();
        const pendingThreshold = new Date(now.getTime() - pendingTtlMs).toISOString();
        const dispatchedThreshold = new Date(now.getTime() - dispatchedTtlMs).toISOString();

        const updateHandoffs = opts.services.db.transaction(() => {
          const stmt = opts.services.db.query(`
            UPDATE handoffs
            SET 
              status = 'expired',
              resolved_at = ?1,
              resolution_reason = CASE 
                WHEN status = 'pending' THEN ?2
                WHEN status = 'dispatched' THEN ?3
              END
            WHERE (status = 'pending' AND ts < ?4)
               OR (status = 'dispatched' AND ts < ?5)
          `);

          const reasonPending = `expired by sweeper after ${pendingTtlMs}ms in pending`;
          const reasonDispatched = `expired by sweeper after ${dispatchedTtlMs}ms in dispatched`;

          return stmt.run(nowIso, reasonPending, reasonDispatched, pendingThreshold, dispatchedThreshold).changes;
        });

        const count = updateHandoffs();

        if (count > 0) {
          opts.services.log.info({ count }, 'handoff sweeper: marked stuck handoffs as expired');
        }
      } catch (err) {
        opts.services.log.error({ err }, 'handoff sweeper: failed to sweep handoffs');
      }
    },
  };
}
