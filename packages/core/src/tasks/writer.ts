import type { Database } from 'bun:sqlite';
import {
  FileTaskInputSchema,
  type FileTaskInput,
  type TaskRecord,
  type TaskKind,
  type TaskStatus,
  type ExpectedArtifact,
  type Eligibility,
} from './schema.js';

export class TaskNotFound extends Error {
  constructor(public readonly task_id: string) {
    super(`task not found: ${task_id}`);
    this.name = 'TaskNotFound';
  }
}

export interface TaskLeaseRow {
  id: string;
  task_id: string;
  agent_id: string;
  claimed_at: number;
  expires_at: number;
  released_at: number | null;
  release_reason: string | null;
  auction_score: number | null;
}

export interface TaskEventRow {
  id: number;
  task_id: string;
  at: number;
  kind: string;
  actor: string | null;
  payload: unknown | null;
}

export interface TaskDescendants {
  count: number;
  depth: number;
  ids: string[];
}

export interface TaskWithIncludes extends TaskRecord {
  lease?: TaskLeaseRow | null;
  events?: TaskEventRow[];
  descendants?: TaskDescendants;
}

export type TaskInclude = 'lease' | 'events' | 'descendants';

export interface ListFilters {
  status?: TaskStatus;
  kind?: TaskKind;
  parent_task_id?: string;
  origin?: string;
  /** Accepted but ignored — TODO Task 2.1 wires the eligibility filter. */
  eligible_for?: string;
  limit?: number;
  offset?: number;
}

interface TaskDbRow {
  id: string;
  created_at: number;
  updated_at: number;
  created_by_kind: string;
  created_by_id: string;
  parent_task_id: string | null;
  kind: string;
  priority: string;
  prompt: string;
  acceptance_criteria: string | null;
  expected_artifacts: string | null;
  eligibility: string;
  review_eligibility: string | null;
  requires_review: number;
  status: string;
  result_summary: string | null;
  result_artifacts: string | null;
  failure_reason: string | null;
  chain_id: string | null;
  origin: string | null;
}

const PRIORITY_ORDER_SQL = `
  CASE priority
    WHEN 'urgent' THEN 0
    WHEN 'high'   THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low'    THEN 3
    ELSE 4
  END
`;

export class TaskWriter {
  constructor(private readonly db: Database) {}

  file(input: FileTaskInput): { task_id: string } {
    const validated = FileTaskInputSchema.parse(input);
    const task_id = `task_${crypto.randomUUID().toLowerCase()}`;
    const now = Date.now();
    const kind: TaskKind = validated.kind ?? 'work';
    const priority = validated.priority ?? 'normal';
    const requires_review = validated.requires_review ?? false;
    const eligibility = JSON.stringify(validated.eligibility ?? {});
    const review_eligibility = validated.review_eligibility
      ? JSON.stringify(validated.review_eligibility)
      : null;
    const expected_artifacts = validated.expected_artifacts
      ? JSON.stringify(validated.expected_artifacts)
      : null;
    const acceptance_criteria = validated.acceptance_criteria ?? null;
    const parent_task_id = validated.parent_task_id ?? null;
    const origin = validated.origin ?? null;

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO tasks (
          id, created_at, updated_at, created_by_kind, created_by_id,
          parent_task_id, kind, priority, prompt, acceptance_criteria,
          expected_artifacts, eligibility, review_eligibility, requires_review,
          status, result_summary, result_artifacts, failure_reason, chain_id, origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?)`,
        [
          task_id,
          now,
          now,
          validated.created_by_kind,
          validated.created_by_id,
          parent_task_id,
          kind,
          priority,
          validated.prompt,
          acceptance_criteria,
          expected_artifacts,
          eligibility,
          review_eligibility,
          requires_review ? 1 : 0,
          origin,
        ],
      );
      this.db.run(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json)
         VALUES (?, ?, 'filed', ?, NULL)`,
        [task_id, now, validated.created_by_id],
      );
    })();

    return { task_id };
  }

  get(task_id: string, opts?: { include?: TaskInclude[] }): TaskWithIncludes {
    const row = this.db
      .query<TaskDbRow, [string]>(`SELECT * FROM tasks WHERE id = ?`)
      .get(task_id);
    if (!row) throw new TaskNotFound(task_id);

    const result: TaskWithIncludes = hydrateTask(row);
    const include = opts?.include ?? [];

    if (include.includes('lease')) {
      const leaseRow = this.db
        .query<TaskLeaseRow, [string]>(
          `SELECT id, task_id, agent_id, claimed_at, expires_at, released_at, release_reason, auction_score
           FROM task_leases
           WHERE task_id = ? AND released_at IS NULL
           LIMIT 1`,
        )
        .get(task_id);
      result.lease = leaseRow ?? null;
    }

    if (include.includes('events')) {
      const eventRows = this.db
        .query<
          { id: number; task_id: string; at: number; kind: string; actor: string | null; payload_json: string | null },
          [string]
        >(
          `SELECT id, task_id, at, kind, actor, payload_json
           FROM task_events
           WHERE task_id = ?
           ORDER BY id ASC
           LIMIT 100`,
        )
        .all(task_id);
      result.events = eventRows.map(r => ({
        id: r.id,
        task_id: r.task_id,
        at: r.at,
        kind: r.kind,
        actor: r.actor,
        payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      }));
    }

    if (include.includes('descendants')) {
      const rows = this.db
        .query<{ id: string; depth: number }, [string]>(
          `WITH RECURSIVE descendants(id, depth) AS (
             SELECT id, 1 FROM tasks WHERE parent_task_id = ?
             UNION ALL
             SELECT t.id, d.depth + 1
               FROM tasks t
               INNER JOIN descendants d ON t.parent_task_id = d.id
           )
           SELECT id, depth FROM descendants`,
        )
        .all(task_id);
      const ids = rows.map(r => r.id);
      const maxDepth = rows.reduce((m, r) => Math.max(m, r.depth), 0);
      result.descendants = { count: rows.length, depth: maxDepth, ids };
    }

    return result;
  }

  list(filters: ListFilters = {}): TaskRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filters.status !== undefined) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.kind !== undefined) {
      where.push('kind = ?');
      params.push(filters.kind);
    }
    if (filters.parent_task_id !== undefined) {
      where.push('parent_task_id = ?');
      params.push(filters.parent_task_id);
    }
    if (filters.origin !== undefined) {
      where.push('origin = ?');
      params.push(filters.origin);
    }
    // TODO Task 2.1: implement `eligible_for` filter via packages/core/src/tasks/eligibility.ts.

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const sql = `
      SELECT * FROM tasks
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${PRIORITY_ORDER_SQL} ASC, created_at ASC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.db.query<TaskDbRow, (string | number)[]>(sql).all(...params);
    return rows.map(hydrateTask);
  }
}

function hydrateTask(row: TaskDbRow): TaskRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by_kind: row.created_by_kind as TaskRecord['created_by_kind'],
    created_by_id: row.created_by_id,
    parent_task_id: row.parent_task_id,
    kind: row.kind as TaskKind,
    priority: row.priority as TaskRecord['priority'],
    prompt: row.prompt,
    acceptance_criteria: row.acceptance_criteria,
    expected_artifacts: row.expected_artifacts
      ? (JSON.parse(row.expected_artifacts) as ExpectedArtifact[])
      : null,
    eligibility: JSON.parse(row.eligibility) as Eligibility,
    review_eligibility: row.review_eligibility
      ? (JSON.parse(row.review_eligibility) as Eligibility)
      : null,
    requires_review: row.requires_review === 1,
    status: row.status as TaskStatus,
    result_summary: row.result_summary,
    result_artifacts: row.result_artifacts
      ? (JSON.parse(row.result_artifacts) as ExpectedArtifact[])
      : null,
    failure_reason: row.failure_reason,
    chain_id: row.chain_id,
    origin: row.origin,
  };
}
