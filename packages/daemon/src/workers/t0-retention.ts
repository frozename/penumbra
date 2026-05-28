import type { Services } from "@penumbra/core";

export interface RetentionWorkerOpts {
  services: Services;
  retentionDays: number;
  batchSize?: number;
  promoteOrphanEvents?: boolean;
}

export function createT0RetentionWorker(opts: RetentionWorkerOpts) {
  let lastEnv: string | undefined;
  let cachedCondition: string | undefined;

  return {
    async tick(): Promise<void> {
      try {
        const currentEnv = process.env.PROMOTE_ORPHAN_EVENTS;
        if (currentEnv !== lastEnv || cachedCondition === undefined) {
          lastEnv = currentEnv;
          const promoteOrphans = opts.promoteOrphanEvents ?? currentEnv === "true";
          cachedCondition = promoteOrphans
            ? "session_id IN (SELECT session_id FROM t1_rollups WHERE ended_at IS NOT NULL)"
            : "(session_id IS NULL OR session_id IN (SELECT session_id FROM t1_rollups WHERE ended_at IS NOT NULL))";
        }

        const now = new Date(opts.services.clock());
        const threshold = new Date(
          now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const batchSize = opts.batchSize ?? 500;

        let totalPruned = 0;
        const stmt = opts.services.db.query(`
          DELETE FROM t0_events
          WHERE event_id IN (
            SELECT event_id FROM t0_events
            WHERE ingest_ts < ?1
              AND ${cachedCondition}
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
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        if (totalPruned > 0) {
          opts.services.log.info(
            { count: totalPruned, threshold },
            "t0 retention: pruned old events",
          );
        }
      } catch (err) {
        opts.services.log.error({ err }, "t0 retention: failed to prune events");
      }
    },
  };
}
