import type { Database } from "bun:sqlite";
import type { T0Writer } from "@penumbra/core";
import {
  TaskDraftPayloadSchema,
  TaskDraftStalePayloadSchema,
} from "../../../core/src/schemas/task-draft.js";

export interface RefiningStuckRecoverySweeperOpts {
  db: Database;
  reader: {
    listStuckRefining(input: { now: number; olderThanMs: number; limit?: number }): Array<{
      event_id: string;
      ts: string;
      project_id: string | null;
      draft_id: string;
      payload_json: string;
    }>;
  };
  t0Writer: T0Writer;
  intervalMs?: number;
  olderThanMs?: number;
  now?: () => number;
  uuid: () => string;
  machineId: { get(): string };
  log?: { info?: (obj: Record<string, unknown>, msg: string) => void };
}

type DraftEventRow = {
  event_id: string;
  ts: string;
  ingest_ts: string;
  project_id: string | null;
  payload_json: string;
};

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_OLDER_THAN_MS = 30 * 60 * 1000;

export function createRefiningStuckRecoverySweeper(opts: RefiningStuckRecoverySweeperOpts): {
  start(): void;
  stop(): void;
  tick(): void;
} {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const olderThanMs = opts.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;

  const api = {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        try {
          api.tick();
        } catch {
          // keep sweeper alive across transient tick failures
        }
      }, intervalMs);
      if (typeof (timer as any).unref === "function") {
        (timer as any).unref();
      }
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    tick(): void {
      const nowMs = now();
      const stuck = opts.reader.listStuckRefining({ now: nowMs, olderThanMs, limit: 50 });
      let recovered = 0;
      let exhausted = 0;

      for (const row of stuck) {
        const currentRecoveryCount = getCurrentRecoveryCount(opts.db, row.draft_id);
        const original = getOriginalDraftEvent(opts.db, row.draft_id);
        if (!original) continue;

        if (currentRecoveryCount < 2) {
          const payload = TaskDraftPayloadSchema.parse({
            ...JSON.parse(original.payload_json),
            recovery_count: currentRecoveryCount + 1,
            recovered_from: "refining_stuck",
          });
          const at = new Date(nowMs).toISOString();
          opts.t0Writer.write({
            event_id: opts.uuid(),
            ts: at,
            ingest_ts: at,
            source: "daemon",
            source_detail: "sweeper:refining-stuck-recovery",
            project_id: row.project_id,
            user_id: "penumbra",
            machine_id: opts.machineId.get(),
            session_id: null,
            event_type: "task_draft",
            lane: "system",
            provider: null,
            model: null,
            tokens_in: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: null,
            request_id: null,
            payload_json: payload,
            payload_summary: payload.prompt.slice(0, 240),
            origin: "unknown",
          });
          recovered++;
        } else {
          const payload = TaskDraftStalePayloadSchema.parse({
            draft_id: row.draft_id,
            stale_reason: "refining_stuck_exhausted",
            details: `recovery_count=${currentRecoveryCount}`,
          });
          const at = new Date(nowMs).toISOString();
          opts.t0Writer.write({
            event_id: opts.uuid(),
            ts: at,
            ingest_ts: at,
            source: "daemon",
            source_detail: "sweeper:refining-stuck-recovery",
            project_id: row.project_id,
            user_id: "penumbra",
            machine_id: opts.machineId.get(),
            session_id: null,
            event_type: "task_draft_stale",
            lane: "system",
            provider: null,
            model: null,
            tokens_in: null,
            tokens_out: null,
            cost_usd: null,
            latency_ms: null,
            request_id: null,
            payload_json: payload,
            payload_summary: "refining stuck exhausted",
            origin: "unknown",
          });
          exhausted++;
        }
      }

      opts.log?.info?.({ recovered, exhausted }, "refining-stuck-recovery tick");
    },
  };

  return api;
}

function getCurrentRecoveryCount(db: Database, draftId: string): number {
  const row = db
    .query<{ recovery_count: number | null }, [string]>(
      `SELECT json_extract(payload_json, '$.recovery_count') AS recovery_count
       FROM t0_events
       WHERE json_extract(payload_json, '$.draft_id') = ?
         AND event_type = 'task_draft'
       ORDER BY ts DESC, ingest_ts DESC, event_id DESC
       LIMIT 1`,
    )
    .get(draftId);
  return row?.recovery_count ?? 0;
}

function getOriginalDraftEvent(db: Database, draftId: string): DraftEventRow | null {
  return (
    db
      .query<DraftEventRow, [string]>(
        `SELECT event_id, ts, ingest_ts, project_id, payload_json
         FROM t0_events
         WHERE json_extract(payload_json, '$.draft_id') = ?
           AND event_type = 'task_draft'
         ORDER BY ts ASC, ingest_ts ASC, event_id ASC
         LIMIT 1`,
      )
      .get(draftId) ?? null
  );
}
