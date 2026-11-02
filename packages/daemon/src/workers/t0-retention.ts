import type { Services } from "@penumbra/core";

export interface RetentionWorkerOpts {
  services: Services;
  retentionDays: number;
  batchSize?: number;
  promoteOrphanEvents?: boolean;
}

export interface T0RetentionWorker {
  tick(): Promise<void>;
}

export function createT0RetentionWorker(opts: RetentionWorkerOpts): T0RetentionWorker {
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

        // bun:sqlite is synchronous: one statement blocks the event loop. The
        // retention predicate inside a LIMIT'd subquery makes SQLite search
        // the whole prunable index space for `batchSize` matches per
        // statement (multi-index OR over t0_by_session_type_ts probing every
        // ended session's rows — ~25 s stalls observed on a 480k-row table).
        // Paginate a bounded candidate window over the ingest_ts index with a
        // keyset (ingest_ts, rowid) cursor instead: the SELECT visits at most
        // batchSize index entries, and the unchanged predicate decides which
        // of those candidates are deleted. The cursor advances past
        // non-deleted candidates too, so every batch makes progress and the
        // union of batches covers exactly the rows the old statement deleted.
        const selectBatch = opts.services.db.query<
          { rowid: number; ingest_ts: string },
          [string, string, number, number]
        >(`
          SELECT rowid, ingest_ts FROM t0_events
          WHERE ingest_ts < ?1
            AND (ingest_ts > ?2 OR (ingest_ts = ?2 AND rowid > ?3))
          ORDER BY ingest_ts, rowid
          LIMIT ?4
        `);
        const deleteBatch = opts.services.db.query<{ rowid: number }, [string]>(`
          DELETE FROM t0_events
          WHERE rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?1))
            AND ${cachedCondition}
          RETURNING rowid
        `);

        const runBatch = opts.services.db.transaction(
          (thresh: string, cursorTs: string, cursorRowid: number, limit: number) => {
            const candidates = selectBatch.all(thresh, cursorTs, cursorRowid, limit);
            if (candidates.length === 0) return { deleted: 0, candidates };
            const deleted = deleteBatch.all(JSON.stringify(candidates.map((c) => c.rowid))).length;
            return { deleted, candidates };
          },
        );

        let totalPruned = 0;
        let cursorTs = "";
        let cursorRowid = -1;
        for (;;) {
          const { deleted, candidates } = runBatch(threshold, cursorTs, cursorRowid, batchSize);
          const last = candidates.at(-1);
          if (last === undefined) break;
          totalPruned += deleted;
          cursorTs = last.ingest_ts;
          cursorRowid = last.rowid;
          if (candidates.length < batchSize) break;
          await new Promise((resolve) => setImmediate(resolve));
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
