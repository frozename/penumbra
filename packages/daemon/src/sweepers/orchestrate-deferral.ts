import type { TaskEventBus } from "@penumbra/core";
import type { Database } from "bun:sqlite";

export interface OrchestrateDeferralSweeperOpts {
  db: Database;
  bus: TaskEventBus;
  intervalMs?: number;
  now?: () => number;
}

export interface OrchestrateDeferralSweepResult {
  candidates: string[];
  resumed: string[];
}

const DEFAULT_INTERVAL_MS = 30_000;

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

type DeferredCandidateRow = {
  task_id: string;
  deferred_at: number;
  resume_at_ms: number;
};

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export function runOrchestrateDeferralSweep(
  opts: Pick<OrchestrateDeferralSweeperOpts, "db" | "bus"> & { now?: () => number },
): OrchestrateDeferralSweepResult {
  const nowMs = (opts.now ?? Date.now)();
  const rows = opts.db
    .query<DeferredCandidateRow, [number]>(
      `SELECT d.task_id AS task_id,
            d.at AS deferred_at,
            CAST(json_extract(d.payload_json, '$.resume_at_ms') AS INTEGER) AS resume_at_ms
     FROM task_events d
     WHERE d.kind = 'orchestrate_deferred'
       AND d.payload_json IS NOT NULL
       AND json_type(d.payload_json, '$.resume_at_ms') IN ('integer', 'real')
       AND CAST(json_extract(d.payload_json, '$.resume_at_ms') AS INTEGER) <= ?
       AND NOT EXISTS (
         SELECT 1
         FROM task_events later
         WHERE later.task_id = d.task_id
           AND later.at > d.at
           AND later.kind IN ('orchestrate_spawned', 'orchestrate_terminated', 'orchestrate_resumed', 'orchestrate_deferred')
       )
     ORDER BY d.at ASC`,
    )
    .all(nowMs);

  const candidates: string[] = [];
  const resumed: string[] = [];
  for (const row of rows) {
    candidates.push(row.task_id);
    const terminated = opts.db
      .query<
        { terminated_at: number | null } | null,
        [string]
      >(`SELECT terminated_at FROM maestro_sessions WHERE task_id = ? LIMIT 1`)
      .get(row.task_id);
    if (terminated?.terminated_at !== null && terminated?.terminated_at !== undefined) {
      continue;
    }

    opts.db
      .query<unknown, [string, string, number, string]>(
        `INSERT INTO task_events (task_id, maestro_session_task_id, at, kind, actor, payload_json)
       VALUES (?, ?, ?, 'orchestrate_resumed', NULL, ?)`,
      )
      .run(
        row.task_id,
        row.task_id,
        nowMs,
        JSON.stringify({
          resumed_at_ms: nowMs,
          resume_at_ms: row.resume_at_ms,
          deferred_at: row.deferred_at,
        }),
      );
    opts.bus.publish({
      task_id: row.task_id,
      at: nowMs,
      kind: "filed",
      actor: null,
      payload: null,
    });
    resumed.push(row.task_id);
  }

  return { candidates, resumed };
}

export function createOrchestrateDeferralSweeper(opts: OrchestrateDeferralSweeperOpts): {
  start(): void;
  stop(): void;
} {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        try {
          runOrchestrateDeferralSweep({ db: opts.db, bus: opts.bus, now });
        } catch {
          // keep sweeper alive after per-tick failures
        }
      }, intervalMs);
      maybeUnref(timer);
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
