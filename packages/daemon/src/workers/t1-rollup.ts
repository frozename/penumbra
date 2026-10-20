import { ContextFileWriter, type Services, T1Rollup } from "@penumbra/core";

export interface RollupWorkerOpts {
  services: Services;
  idleMinutes: number;
  topK?: number;
  overwriteOnReroll?: boolean;
  /** Injection seam for tests; defaults to a real T1Rollup over services.db. */
  t1?: Pick<T1Rollup, "detectIdleSessions" | "rollupSession">;
}

export interface RollupWorker {
  tick(): Promise<void>;
}

// Full-table idle scans run on the first tick (covers daemon downtime) and then
// once an hour at the default 60 s cadence; other ticks only consider sessions
// with rows ingested inside the lookback. The lookback must span several idle
// windows so a just-rolled session that keeps emitting events stays visible.
const FULL_SCAN_EVERY_N_TICKS = 60;
const MIN_INGEST_LOOKBACK_MINUTES = 60;
const INGEST_LOOKBACK_IDLE_MULTIPLE = 6;

export function createRollupWorker(opts: RollupWorkerOpts): RollupWorker {
  const t1 =
    opts.t1 ??
    new T1Rollup({
      db: opts.services.db,
      embedder: opts.services.embedder,
      clock: opts.services.clock,
      uuid: opts.services.uuid,
    });
  const ctx = new ContextFileWriter({
    db: opts.services.db,
    storageRoot: opts.services.storageRoot,
    topK: opts.topK ?? 10,
  });
  const ingestLookbackMs =
    Math.max(INGEST_LOOKBACK_IDLE_MULTIPLE * opts.idleMinutes, MIN_INGEST_LOOKBACK_MINUTES) *
    60_000;

  let lastEnv: string | undefined;
  let cachedOverwrite: boolean | undefined;
  let tickIndex = 0;

  return {
    async tick(): Promise<void> {
      const currentEnv = process.env.MEMORY_OVERWRITE_ON_REROLL;
      if (currentEnv !== lastEnv) {
        lastEnv = currentEnv;
        cachedOverwrite = currentEnv === "true";
      }
      const overwrite = opts.overwriteOnReroll ?? cachedOverwrite;

      const now = opts.services.clock();
      const fullScan = tickIndex % FULL_SCAN_EVERY_N_TICKS === 0;
      tickIndex += 1;
      const sessions = fullScan
        ? t1.detectIdleSessions(opts.idleMinutes, now)
        : t1.detectIdleSessions(opts.idleMinutes, now, {
            ingestedSince: new Date(now.getTime() - ingestLookbackMs).toISOString(),
          });
      for (const sessionId of sessions) {
        try {
          const id = await t1.rollupSession(sessionId, overwrite);
          if (id) {
            const projectRow = opts.services.db
              .query<
                { project_id: string | null },
                [string]
              >("SELECT project_id FROM t1_rollups WHERE rollup_id=?")
              .get(id);
            if (projectRow?.project_id) ctx.rewrite(projectRow.project_id);
          }
        } catch (err) {
          opts.services.log.warn({ sessionId, err }, "rollup worker: session failed, skipping");
        }
      }
    },
  };
}
