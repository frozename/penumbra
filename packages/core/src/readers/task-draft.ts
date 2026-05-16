import type { Database } from 'bun:sqlite';
import { TaskDraftPayloadSchema, type TaskDraftPayload } from '../schemas/task-draft.js';

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
  filed_via: 'skill_inline' | 'stop_hook';
  parent_draft_id: string | null;
  provenance?: { filing_path: string; session_id: string; extractor_version: string; filtered_by: string[] };
};

export type ListPendingInput = {
  latest_event_type: 'task_draft' | 'task_draft_escalation';
  project_id: string;
  limit?: number;
};

export class TaskDraftReader {
  constructor(private readonly opts: { db: Database }) {}

  listPending(input: ListPendingInput): PendingTaskDraft[] {
    const limit = clampLimit(input.limit);
    if (input.latest_event_type === 'task_draft_escalation') {
      console.warn('task_draft_escalation surface awaits dedicated reader — returning empty');
      return [];
    }
    const rows = this.queryPending(input.latest_event_type, limit, input.project_id);
    const out: PendingTaskDraft[] = [];
    for (const row of rows) {
      try {
        const payload = this.parseRowPayload(row);
        out.push(mapPendingTaskDraft(row, payload));
      } catch (err) {
        console.warn('task draft reader skipped invalid payload', { event_id: row.event_id, err });
      }
    }
    return out;
  }

  private queryPending(latestEventType: ListPendingInput['latest_event_type'], limit: number, projectId: string): Array<{
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
    return this.opts.db.query<{
      event_id: string;
      ts: string;
      project_id: string | null;
      event_type: string;
      draft_id: string;
      payload_json: string;
    }, [ListPendingInput['latest_event_type'], string, number]>(sql).all(latestEventType, projectId, limit);
  }

  private parseRowPayload(
    row: { draft_id: string; event_type: string; payload_json: string },
  ): TaskDraftPayload {
    const rawPayload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
    return TaskDraftPayloadSchema.parse(rawPayload as unknown);
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined) return 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('limit out of range');
  }
  return limit;
}

function mapPendingTaskDraft(row: { event_id: string; ts: string; project_id: string | null }, payload: TaskDraftPayload): PendingTaskDraft {
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
