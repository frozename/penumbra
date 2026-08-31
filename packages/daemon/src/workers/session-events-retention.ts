import type { Services } from "@penumbra/core";

export interface SessionEventsRetentionOpts {
  services: Services;
  retentionDays: number;
  batchSize?: number;
}

export interface SessionEventsRetentionWorker {
  tick(): Promise<void>;
}

const SESSION_EVENTS_RETENTION_MAX_DELETE_PER_TICK = 100_000;
const SESSION_EVENTS_RETENTION_BATCH_YIELD_MS = 50;

function buildDeleteBatch(services: Services): (threshold: string, limit: number) => number {
  const stmt = services.db.query(`
    DELETE FROM session_events
    WHERE id IN (
      SELECT id FROM session_events
      WHERE ts < ?1
      ORDER BY ts ASC, id ASC
      LIMIT ?2
    )
  `);
  return services.db.transaction((threshold: string, limit: number) => {
    return stmt.run(threshold, limit).changes;
  });
}

function countRemainingBacklog(services: Services, threshold: string): number {
  return (
    services.db
      .query<
        { count: number },
        [string]
      >("SELECT COUNT(*) AS count FROM session_events WHERE ts < ?")
      .get(threshold)?.count ?? 0
  );
}

async function pruneBacklog(
  deleteBatch: (threshold: string, limit: number) => number,
  threshold: string,
  batchSize: number,
): Promise<number> {
  let totalPruned = 0;
  for (;;) {
    const remainingBudget = SESSION_EVENTS_RETENTION_MAX_DELETE_PER_TICK - totalPruned;
    if (remainingBudget <= 0) break;
    const requested = Math.min(batchSize, remainingBudget);
    const changes = deleteBatch(threshold, requested);
    if (changes === 0) break;
    totalPruned += changes;
    if (changes < requested) break;
    if (totalPruned >= SESSION_EVENTS_RETENTION_MAX_DELETE_PER_TICK) break;
    await new Promise((resolve) => setTimeout(resolve, SESSION_EVENTS_RETENTION_BATCH_YIELD_MS));
  }
  return totalPruned;
}

export function createSessionEventsRetentionWorker(
  opts: SessionEventsRetentionOpts,
): SessionEventsRetentionWorker {
  return {
    async tick(): Promise<void> {
      try {
        const now = new Date(opts.services.clock());
        const threshold = new Date(
          now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const batchSize = opts.batchSize ?? 1000;

        const totalPruned = await pruneBacklog(
          buildDeleteBatch(opts.services),
          threshold,
          batchSize,
        );

        if (totalPruned > 0) {
          opts.services.log.info(
            { count: totalPruned, threshold },
            "session-events retention: pruned old events",
          );
        }
        if (totalPruned >= SESSION_EVENTS_RETENTION_MAX_DELETE_PER_TICK) {
          const remaining = countRemainingBacklog(opts.services, threshold);
          if (remaining > 0) {
            opts.services.log.info(
              { count: totalPruned, remaining, threshold },
              "session-events retention: backlog remains for next tick",
            );
          }
        }
      } catch (err) {
        opts.services.log.error({ err }, "session-events retention: failed to prune events");
      }
    },
  };
}
