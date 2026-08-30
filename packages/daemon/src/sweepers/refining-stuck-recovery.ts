import type { T0Writer } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { TaskDraftPayloadSchema, TaskDraftStalePayloadSchema } from "@penumbra/core";

interface StuckRow {
  event_id: string;
  ts: string;
  project_id: string | null;
  draft_id: string;
  payload_json: string;
}

export interface RefiningStuckRecoverySweeperOpts {
  db: Database;
  reader: {
    listStuckRefining(input: { now: number; olderThanMs: number; limit?: number }): StuckRow[];
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

interface DraftWriteContext {
  t0Writer: T0Writer;
  uuid: () => string;
  machineId: { get(): string };
  projectId: string | null;
  nowMs: number;
}

function writeRecoveryDraft(
  ctx: DraftWriteContext,
  original: DraftEventRow,
  recoveryCount: number,
): void {
  const originalPayload = JSON.parse(original.payload_json) as Record<string, unknown>;
  const payload = TaskDraftPayloadSchema.parse({
    ...originalPayload,
    recovery_count: recoveryCount + 1,
    recovered_from: "refining_stuck",
  });
  const at = new Date(ctx.nowMs).toISOString();
  ctx.t0Writer.write({
    event_id: ctx.uuid(),
    ts: at,
    ingest_ts: at,
    source: "daemon",
    source_detail: "sweeper:refining-stuck-recovery",
    project_id: ctx.projectId,
    user_id: "penumbra",
    machine_id: ctx.machineId.get(),
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
}

function writeStaleDraft(
  ctx: DraftWriteContext,
  draftId: string,
  reason: "refining_stuck_exhausted" | "refining_stuck",
  details: string,
  summary: string,
): void {
  const payload = TaskDraftStalePayloadSchema.parse({
    draft_id: draftId,
    stale_reason: reason,
    details,
  });
  const at = new Date(ctx.nowMs).toISOString();
  ctx.t0Writer.write({
    event_id: ctx.uuid(),
    ts: at,
    ingest_ts: at,
    source: "daemon",
    source_detail: "sweeper:refining-stuck-recovery",
    project_id: ctx.projectId,
    user_id: "penumbra",
    machine_id: ctx.machineId.get(),
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
    payload_summary: summary,
    origin: "unknown",
  });
}

interface ProcessOutcome {
  recovered: number;
  exhausted: number;
  skippedInvalid: number;
}

function processStuckRow(
  opts: RefiningStuckRecoverySweeperOpts,
  row: StuckRow,
  nowMs: number,
): ProcessOutcome {
  const ctx: DraftWriteContext = {
    t0Writer: opts.t0Writer,
    uuid: opts.uuid,
    machineId: opts.machineId,
    projectId: row.project_id,
    nowMs,
  };

  try {
    const currentRecoveryCount = getCurrentRecoveryCount(opts.db, row.draft_id);
    const original = getOriginalDraftEvent(opts.db, row.draft_id);
    if (!original) return { recovered: 0, exhausted: 0, skippedInvalid: 0 };

    if (currentRecoveryCount < 2) {
      writeRecoveryDraft(ctx, original, currentRecoveryCount);
      return { recovered: 1, exhausted: 0, skippedInvalid: 0 };
    }
    writeStaleDraft(
      ctx,
      row.draft_id,
      "refining_stuck_exhausted",
      `recovery_count=${String(currentRecoveryCount)}`,
      "refining stuck exhausted",
    );
    return { recovered: 0, exhausted: 1, skippedInvalid: 0 };
  } catch (err) {
    // A single poison-pill row (malformed JSON or schema-invalid payload)
    // must not block recovery of the other stuck drafts in this batch.
    opts.log?.info?.(
      {
        draft_id: row.draft_id,
        event_id: row.event_id,
        err: err instanceof Error ? err.message : String(err),
      },
      "refining-stuck-recovery skipped invalid payload",
    );
    // Best-effort: mark the poison row stale so listStuckRefining stops
    // re-selecting it on every subsequent tick. If even the stale-event
    // payload can't be validated (e.g. draft_id itself is not a UUID),
    // give up silently — log line above is the record.
    try {
      writeStaleDraft(
        ctx,
        row.draft_id,
        "refining_stuck",
        "invalid_payload",
        "refining stuck invalid payload",
      );
    } catch {
      // unrecoverable — row will re-appear next tick but will be skipped again
    }
    return { recovered: 0, exhausted: 0, skippedInvalid: 1 };
  }
}

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
      timer.unref();
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
      let skipped_invalid = 0;

      for (const row of stuck) {
        const outcome = processStuckRow(opts, row, nowMs);
        recovered += outcome.recovered;
        exhausted += outcome.exhausted;
        skipped_invalid += outcome.skippedInvalid;
      }

      opts.log?.info?.({ recovered, exhausted, skipped_invalid }, "refining-stuck-recovery tick");
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
