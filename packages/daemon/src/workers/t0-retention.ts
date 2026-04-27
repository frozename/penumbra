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
            WHERE ts < ?1
              AND session_id IN (SELECT session_id FROM t1_rollups WHERE ended_at IS NOT NULL)
            LIMIT ?2
          )
        `);

        while (true) {
          // stmt.run() in bun:sqlite returns { changes, lastInsertRowid } usually
          // However, we just do it safely.
          opts.services.db.run('BEGIN TRANSACTION');
          let changes = 0;
          try {
            stmt.run(threshold, batchSize);
            changes = (opts.services.db.query('SELECT changes() AS c').get() as any).c;
            opts.services.db.run('COMMIT');
          } catch (err) {
            opts.services.db.run('ROLLBACK');
            throw err;
          }

          if (changes === 0) break;
          totalPruned += changes;
          if (changes < batchSize) break;
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
