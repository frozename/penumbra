import type { Services } from '@penumbra/core';

export interface RetentionWorkerOpts {
  services: Services;
  retentionDays: number;
  batchSize?: number;
}

export function createT0RetentionWorker(opts: RetentionWorkerOpts) {
  return {
    async tick(): Promise<void> {
      try {
        const now = new Date(opts.services.clock());
        const threshold = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const batchSize = opts.batchSize ?? 500;
        
        let totalPruned = 0;
        const stmt = opts.services.db.query(`
          DELETE FROM t0_events
          WHERE event_id IN (
            SELECT event_id FROM t0_events
            WHERE ingest_ts < ?1
              AND session_id IN (SELECT session_id FROM t1_rollups WHERE ended_at IS NOT NULL)
            LIMIT ?2
          )
        `);

        const deleteBatch = opts.services.db.transaction((thresh: string, limit: number) => {
          return stmt.run(thresh, limit).changes;
        });

        while (true) {
          const changes = deleteBatch(threshold, batchSize);
          if (changes === 0) break;
          totalPruned += changes;
          if (changes < batchSize) break;
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (totalPruned > 0) {
          opts.services.log.info({ count: totalPruned, threshold }, 't0 retention: pruned old events');
        }
      } catch (err) {
        opts.services.log.error({ err }, 't0 retention: failed to prune events');
      }
    },
  };
}
