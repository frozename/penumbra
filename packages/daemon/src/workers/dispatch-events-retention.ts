import type { Services } from "@penumbra/core";

export interface DispatchEventsRetentionOpts {
  services: Services;
  retentionDays: number;
  batchSize?: number;
}

export interface DispatchEventsRetentionWorker {
  tick(): Promise<void>;
}

/**
 * Prunes old rows from dispatch_events, which is high-volume operational
 * telemetry (~95% heartbeat/lifecycle rows) with no rollup and previously no
 * retention — it grew unbounded (~1.9M rows / ~470MB observed). Mirrors
 * t0-retention: a batched DELETE under the existing idx_dispatch_events_ts, with
 * a microtask yield between batches so a large first prune doesn't block the
 * event loop. Keyed on the table's INTEGER PRIMARY KEY (id) for a cheap
 * LIMIT-able subquery.
 */
export function createDispatchEventsRetentionWorker(
  opts: DispatchEventsRetentionOpts,
): DispatchEventsRetentionWorker {
  return {
    async tick(): Promise<void> {
      try {
        const now = new Date(opts.services.clock());
        const threshold = new Date(
          now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const batchSize = opts.batchSize ?? 1000;

        const stmt = opts.services.db.query(`
          DELETE FROM dispatch_events
          WHERE id IN (
            SELECT id FROM dispatch_events
            WHERE ts < ?1
            LIMIT ?2
          )
        `);
        const deleteBatch = opts.services.db.transaction((thresh: string, limit: number) => {
          return stmt.run(thresh, limit).changes;
        });

        let totalPruned = 0;
        for (;;) {
          const changes = deleteBatch(threshold, batchSize);
          if (changes === 0) break;
          totalPruned += changes;
          if (changes < batchSize) break;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        if (totalPruned > 0) {
          opts.services.log.info(
            { count: totalPruned, threshold },
            "dispatch-events retention: pruned old events",
          );
        }
      } catch (err) {
        opts.services.log.error({ err }, "dispatch-events retention: failed to prune events");
      }
    },
  };
}
