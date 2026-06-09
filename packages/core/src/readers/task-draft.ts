import type { Database } from "bun:sqlite";
import {
  TaskDraftEscalationPayloadSchema,
  TaskDraftPayloadSchema,
  type TaskDraftEscalationPayload,
  type TaskDraftPayload,
} from "../schemas/task-draft.js";

export type PendingTaskDraft = {
  event_id: string;
  ts: string;
  project_id: string | null;
  draft_id: string;
  prompt: string;
  affects_projects: string[];
  evidence: { conv_ids?: string[]; commits?: string[]; files?: string[]; session_id?: string };
  auto_ok: boolean;
  filed_by_agent: string;
  filed_via: "skill_inline" | "stop_hook";
  parent_draft_id: string | null;
  provenance?: {
    filing_path: string;
    session_id: string;
    extractor_version: string;
    filtered_by: string[];
  };
};

export type ListPendingInput = {
  latest_event_type: "task_draft" | "task_draft_escalation";
  project_id: string;
  limit?: number;
};

export type PendingTaskDraftEscalation = PendingTaskDraft & {
  escalation_reason: string;
  escalation_event_id: string;
  escalation_ts: string;
};

export type ListPendingEscalationsInput = {
  project_id: string;
  limit?: number;
};

export type StuckRefiningTaskDraft = {
  event_id: string;
  ts: string;
  project_id: string | null;
  draft_id: string;
  payload_json: string;
};

export function getTaskDraftPromotionInfo(
  db: Database,
  draftId: string,
): {
  exists: boolean;
  auto_ok: boolean;
  filed_by_agent: string | null;
  already_promoted: boolean;
} {
  const row = db
    .query<
      {
        has_draft: number;
        auto_ok: number | null;
        filed_by_agent: string | null;
        already_promoted: number;
      },
      [string, string]
    >(
      `WITH earliest AS (
         SELECT
           1 AS has_draft,
           json_extract(payload_json, '$.auto_ok') AS auto_ok,
           json_extract(payload_json, '$.filed_by_agent') AS filed_by_agent
         FROM t0_events
         WHERE json_extract(payload_json, '$.draft_id') = ?
           AND event_type = 'task_draft'
         ORDER BY ts ASC, ingest_ts ASC, event_id ASC
         LIMIT 1
       ),
       promoted AS (
         SELECT 1 AS already_promoted
         FROM t0_events
         WHERE json_extract(payload_json, '$.draft_id') = ?
           AND event_type = 'task_draft_promoted'
         LIMIT 1
       )
       SELECT
         COALESCE((SELECT has_draft FROM earliest), 0) AS has_draft,
         (SELECT auto_ok FROM earliest) AS auto_ok,
         (SELECT filed_by_agent FROM earliest) AS filed_by_agent,
         COALESCE((SELECT already_promoted FROM promoted), 0) AS already_promoted`,
    )
    .get(draftId, draftId);

  return {
    exists: row?.has_draft === 1,
    auto_ok: row?.auto_ok === 1,
    filed_by_agent: row?.filed_by_agent ?? null,
    already_promoted: row?.already_promoted === 1,
  };
}

export class TaskDraftReader {
  constructor(private readonly opts: { db: Database }) {}

  getPromotionInfo(draftId: string): {
    exists: boolean;
    auto_ok: boolean;
    filed_by_agent: string | null;
    already_promoted: boolean;
  } {
    return getTaskDraftPromotionInfo(this.opts.db, draftId);
  }

  listPending(input: ListPendingInput): PendingTaskDraft[] {
    const limit = clampLimit(input.limit);
    if (input.latest_event_type === "task_draft_escalation") {
      console.warn("task_draft_escalation surface awaits dedicated reader — returning empty");
      return [];
    }
    const rows = this.queryPending(input.latest_event_type, limit, input.project_id);
    const out: PendingTaskDraft[] = [];
    for (const row of rows) {
      try {
        const payload = this.parseRowPayload(row);
        out.push(mapPendingTaskDraft(row, payload));
      } catch (err) {
        console.warn("task draft reader skipped invalid payload", { event_id: row.event_id, err });
      }
    }
    return out;
  }

  listPendingEscalations(input: ListPendingEscalationsInput): PendingTaskDraftEscalation[] {
    const limit = clampLimit(input.limit);
    const rows = this.queryPendingEscalations(limit, input.project_id);
    const out: PendingTaskDraftEscalation[] = [];
    for (const row of rows) {
      try {
        if (row.original_project_id !== row.escalation_project_id) {
          console.warn("task draft escalation reader skipped cross-project join", {
            escalation_event_id: row.escalation_event_id,
            escalation_project_id: row.escalation_project_id,
            original_event_id: row.original_event_id,
            original_project_id: row.original_project_id,
          });
          continue;
        }
        const originalPayload = this.parseDraftPayload(row.original_payload);
        const escalationPayload = this.parseEscalationPayload(row.escalation_payload);
        out.push({
          ...mapPendingTaskDraft(
            {
              event_id: row.original_event_id,
              ts: row.original_ts,
              project_id: row.original_project_id,
            },
            originalPayload,
          ),
          event_id: row.escalation_event_id,
          ts: row.escalation_ts,
          project_id: row.original_project_id,
          escalation_reason: escalationPayload.escalation_reason,
          escalation_event_id: row.escalation_event_id,
          escalation_ts: row.escalation_ts,
        });
      } catch (err) {
        console.warn("task draft escalation reader skipped invalid payload", {
          escalation_event_id: row.escalation_event_id,
          original_event_id: row.original_event_id,
          err,
        });
      }
    }
    return out;
  }

  listStuckRefining(input: {
    now: number;
    olderThanMs: number;
    limit?: number;
  }): StuckRefiningTaskDraft[] {
    const limit = clampLimit(input.limit);
    const cutoff = new Date(input.now - input.olderThanMs).toISOString();
    const rows = this.queryStuckRefining(cutoff, limit);
    const out: StuckRefiningTaskDraft[] = [];
    for (const row of rows) {
      out.push(row);
    }
    return out;
  }

  private queryPending(
    latestEventType: ListPendingInput["latest_event_type"],
    limit: number,
    projectId: string,
  ): Array<{
    event_id: string;
    ts: string;
    project_id: string | null;
    event_type: string;
    draft_id: string;
    payload_json: string;
  }> {
    const sql = `WITH ranked AS (
        SELECT
          event_id, ts, ingest_ts, project_id, event_type, payload_json,
          json_extract(payload_json, '$.draft_id') AS draft_id,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.draft_id')
            ORDER BY ts DESC, ingest_ts DESC
          ) AS rn
        FROM t0_events
        WHERE event_type IN (
          'task_draft','task_draft_refining','task_draft_promoted',
          'task_draft_stale','task_draft_duplicate','task_draft_escalation'
        )
      )
      SELECT event_id, ts, project_id, event_type, draft_id, payload_json
      FROM ranked
      WHERE rn = 1
        AND event_type = ?
        AND project_id = ?
      ORDER BY ts ASC, ingest_ts ASC, event_id ASC
      LIMIT ?`;
    return this.opts.db
      .query<
        {
          event_id: string;
          ts: string;
          project_id: string | null;
          event_type: string;
          draft_id: string;
          payload_json: string;
        },
        [ListPendingInput["latest_event_type"], string, number]
      >(sql)
      .all(latestEventType, projectId, limit);
  }

  private queryStuckRefining(cutoffIso: string, limit: number): StuckRefiningTaskDraft[] {
    const sql = `WITH ranked AS (
        SELECT
          event_id, ts, ingest_ts, project_id, event_type, payload_json,
          json_extract(payload_json, '$.draft_id') AS draft_id,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.draft_id')
            ORDER BY ts DESC, ingest_ts DESC
          ) AS rn
        FROM t0_events
        WHERE event_type IN (
          'task_draft','task_draft_refining','task_draft_promoted',
          'task_draft_stale','task_draft_duplicate','task_draft_escalation'
        )
      )
      SELECT event_id, ts, project_id, draft_id, payload_json
      FROM ranked
      WHERE rn = 1
        AND event_type = 'task_draft_refining'
        AND ts < ?
      ORDER BY ts ASC, ingest_ts ASC, event_id ASC
      LIMIT ?`;
    return this.opts.db.query<StuckRefiningTaskDraft, [string, number]>(sql).all(cutoffIso, limit);
  }

  private parseRowPayload(row: {
    draft_id: string;
    event_type: string;
    payload_json: string;
  }): TaskDraftPayload {
    const rawPayload =
      typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
    return TaskDraftPayloadSchema.parse(rawPayload as unknown);
  }

  private parseDraftPayload(payloadJson: string): TaskDraftPayload {
    const rawPayload = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
    return TaskDraftPayloadSchema.parse(rawPayload as unknown);
  }

  private parseEscalationPayload(payloadJson: string): TaskDraftEscalationPayload {
    const rawPayload = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
    return TaskDraftEscalationPayloadSchema.parse(rawPayload as unknown);
  }

  private queryPendingEscalations(
    limit: number,
    projectId: string,
  ): Array<{
    escalation_event_id: string;
    escalation_ts: string;
    escalation_payload: string;
    escalation_project_id: string | null;
    original_event_id: string;
    original_ts: string;
    original_project_id: string | null;
    original_payload: string;
  }> {
    const sql = `WITH ranked AS (
        SELECT
          event_id, ts, ingest_ts, project_id, event_type, payload_json,
          json_extract(payload_json, '$.draft_id') AS draft_id,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.draft_id')
            ORDER BY ts DESC, ingest_ts DESC
          ) AS rn
        FROM t0_events
        WHERE event_type IN (
          'task_draft','task_draft_refining','task_draft_promoted',
          'task_draft_stale','task_draft_duplicate','task_draft_escalation'
        )
      ),
      originals AS (
        SELECT
          event_id, ts, project_id, payload_json,
          json_extract(payload_json, '$.draft_id') AS draft_id,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(payload_json, '$.draft_id'), project_id
            ORDER BY ts ASC, ingest_ts ASC, event_id ASC
          ) AS rn
        FROM t0_events
        WHERE event_type = 'task_draft'
      )
      SELECT
        ranked.event_id AS escalation_event_id,
        ranked.ts AS escalation_ts,
        ranked.payload_json AS escalation_payload,
        ranked.project_id AS escalation_project_id,
        originals.event_id AS original_event_id,
        originals.ts AS original_ts,
        originals.project_id AS original_project_id,
        originals.payload_json AS original_payload
      FROM ranked
      JOIN originals
        ON originals.draft_id = ranked.draft_id
        AND originals.project_id = ranked.project_id
        AND originals.rn = 1
      WHERE ranked.rn = 1
        AND ranked.event_type = 'task_draft_escalation'
        AND ranked.project_id = ?
      ORDER BY ranked.ts ASC, ranked.ingest_ts ASC, ranked.event_id ASC
      LIMIT ?`;
    return this.opts.db
      .query<
        {
          escalation_event_id: string;
          escalation_ts: string;
          escalation_payload: string;
          escalation_project_id: string | null;
          original_event_id: string;
          original_ts: string;
          original_project_id: string | null;
          original_payload: string;
        },
        [string, number]
      >(sql)
      .all(projectId, limit);
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined) return 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("limit out of range");
  }
  return limit;
}

function mapPendingTaskDraft(
  row: { event_id: string; ts: string; project_id: string | null },
  payload: TaskDraftPayload,
): PendingTaskDraft {
  return {
    event_id: row.event_id,
    ts: row.ts,
    project_id: row.project_id,
    draft_id: payload.draft_id,
    prompt: payload.prompt,
    affects_projects: payload.affects_projects,
    evidence: payload.evidence,
    auto_ok: payload.auto_ok,
    filed_by_agent: payload.filed_by_agent,
    filed_via: payload.filed_via,
    parent_draft_id: payload.parent_draft_id,
    provenance: payload.provenance,
  };
}
