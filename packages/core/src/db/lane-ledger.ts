import type { Database } from "bun:sqlite";

import { z } from "zod";

import type { LaneCloseMetadata } from "../schemas/lane-close-metadata.js";

import { type TaskClass, TaskClassSchema } from "../schemas/task-class.js";

export type LaneGateStatus = "open" | "passed" | "failed" | "skipped" | "review_debt";
export type ClosedLaneGateStatus = Exclude<LaneGateStatus, "open">;
export const LaneGateStatusSchema = z.enum(["open", "passed", "failed", "skipped", "review_debt"]);

export interface LaneRow {
  lane_id: string;
  ts_opened: string;
  ts_closed: string | null;
  task_class: TaskClass;
  implementer_handoff: string;
  reviewer_handoff: string | null;
  gate_status: LaneGateStatus;
  recalled_memory_ids: string[];
  recalled_query: string | null;
  override_reason: string | null;
  metadata_json: string;
}

export interface InsertLaneInput {
  lane_id: string;
  ts_opened: string;
  ts_closed?: string;
  task_class: TaskClass;
  implementer_handoff: string;
  gate_status?: LaneGateStatus;
  recalled_memory_ids?: string[];
  recalled_query?: string | null;
  override_reason?: string | null;
  metadata_json?: string;
}

export interface CloseLaneInput {
  ts_closed: string;
  gate_status: ClosedLaneGateStatus;
  reviewer_handoff?: string | null;
  override_reason?: string | null;
  metadata?: LaneCloseMetadata | null;
}

export interface RecentLaneFilter {
  gate_status?: LaneGateStatus;
  task_class?: TaskClass;
  since_iso?: string;
}

const CLOSED_STATUSES = new Set<Exclude<LaneGateStatus, "open">>([
  "passed",
  "failed",
  "skipped",
  "review_debt",
]);

type StatementWithRun = {
  run: (...params: (string | null)[]) => { changes: number };
};

type StatementWithAll<T> = {
  all: (...params: string[]) => T[];
};

export type StampGateOutcomeLog = {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
};

export function stampAgentPerformanceGateOutcomeForHandoff(
  db: Database,
  handoffId: string,
  gate_status: ClosedLaneGateStatus,
  log?: StampGateOutcomeLog,
  lane_id?: string,
  allowTerminalClose = false,
): string | null {
  const current = db
    .query<
      { gate_outcome: string | null },
      [string]
    >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
    .get(handoffId);
  const suppressesStickyPassed =
    current?.gate_outcome === "passed" &&
    (allowTerminalClose ? gate_status === "skipped" : gate_status !== "passed");
  if (suppressesStickyPassed) {
    log?.warn?.(
      { event: "gate_stamp.suppressed_downgrade", handoff_id: handoffId, lane_id, gate_status },
      "gate stamp suppressed downgrade of sticky passed",
    );
  }
  // Capture the UPDATE row count so a zero-row stamp (close fired before the
  // worker agent_performance capture landed) is observable instead of silently
  // dropping the verdict. Warn-only by design: do NOT add an insert-if-absent
  // write path here; preserving the sticky-CASE monotonicity is load-bearing.
  const stmt = db.prepare(
    `UPDATE agent_performance
     SET gate_outcome = CASE
       WHEN gate_outcome = 'passed' AND ?${
         allowTerminalClose ? " = 'skipped'" : " != 'passed'"
       } THEN gate_outcome
       WHEN gate_outcome IN ('failed', 'review_debt') AND ? IN ('skipped', 'passed') THEN gate_outcome
       ELSE ?
     END
     WHERE handoff_id = ?`,
  );
  const result = stmt.run(gate_status, gate_status, gate_status, handoffId) as { changes: number };
  if (result.changes === 0) {
    log?.warn?.(
      { event: "gate_stamp.no_perf_row", handoff_id: handoffId, lane_id, gate_status },
      "gate stamp matched zero agent_performance rows",
    );
  }
  const row = db
    .query<
      { gate_outcome: string | null },
      [string]
    >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
    .get(handoffId);
  return row?.gate_outcome ?? null;
}

export function stampAgentPerformanceGateOutcome(
  db: Database,
  lane_id: string,
  gate_status: ClosedLaneGateStatus,
  log?: StampGateOutcomeLog,
  allowTerminalClose = false,
): void {
  const row = db
    .query<
      { implementer_handoff: string },
      [string]
    >(`SELECT implementer_handoff FROM lane_ledger WHERE lane_id=?`)
    .get(lane_id);
  if (row === null) {
    throw new Error(`not found: lane ${lane_id}`);
  }
  stampAgentPerformanceGateOutcomeForHandoff(
    db,
    row.implementer_handoff,
    gate_status,
    log,
    lane_id,
    allowTerminalClose,
  );
}

function parseLaneRow(row: {
  lane_id: string;
  ts_opened: string;
  ts_closed: string | null;
  task_class: string;
  implementer_handoff: string;
  reviewer_handoff: string | null;
  gate_status: string;
  recalled_memory_ids: string;
  recalled_query: string | null;
  override_reason: string | null;
  metadata_json: string;
}): LaneRow {
  return {
    lane_id: row.lane_id,
    ts_opened: row.ts_opened,
    ts_closed: row.ts_closed,
    task_class: TaskClassSchema.parse(row.task_class),
    implementer_handoff: row.implementer_handoff,
    reviewer_handoff: row.reviewer_handoff,
    gate_status: LaneGateStatusSchema.parse(row.gate_status),
    recalled_memory_ids: JSON.parse(row.recalled_memory_ids || "[]") as string[],
    recalled_query: row.recalled_query,
    override_reason: row.override_reason,
    metadata_json: row.metadata_json,
  };
}

export function insertLane(db: Database, row: InsertLaneInput): void {
  const gate_status = row.gate_status ?? "open";
  // Fail closed: ts_closed and gate_status must agree at insert time, so a
  // born-closed lane always carries its close time and an open lane can never
  // persist one.
  if (gate_status !== "open" && row.ts_closed === undefined) {
    throw new Error(`invalid lane insert: gate_status '${gate_status}' requires ts_closed`);
  }
  if (gate_status === "open" && row.ts_closed !== undefined) {
    throw new Error("invalid lane insert: gate_status 'open' cannot carry ts_closed");
  }
  (
    db.query(
      `INSERT INTO lane_ledger (
      lane_id, ts_opened, ts_closed, task_class, implementer_handoff, gate_status,
      recalled_memory_ids, recalled_query, override_reason, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ) as StatementWithRun
  ).run(
    row.lane_id,
    row.ts_opened,
    row.ts_closed ?? null,
    row.task_class,
    row.implementer_handoff,
    gate_status,
    JSON.stringify(row.recalled_memory_ids ?? []),
    row.recalled_query ?? null,
    row.override_reason ?? null,
    row.metadata_json ?? "{}",
  );
}

export function closeLane(
  db: Database,
  lane_id: string,
  fields: CloseLaneInput,
  log?: StampGateOutcomeLog,
): void {
  if (!CLOSED_STATUSES.has(fields.gate_status)) {
    throw new Error(`invalid lane gate_status: ${fields.gate_status}`);
  }
  // null → COALESCE preserves prior value; undefined also maps to null (same semantic)
  const metadata_json_value =
    fields.metadata === null || fields.metadata === undefined
      ? null
      : JSON.stringify(fields.metadata);
  const changes = (
    db.query(
      `UPDATE lane_ledger
        SET ts_closed=?, gate_status=?, reviewer_handoff=?, override_reason=?,
            metadata_json = COALESCE(?, metadata_json)
      WHERE lane_id=? AND ts_closed IS NULL`,
    ) as StatementWithRun
  ).run(
    fields.ts_closed,
    fields.gate_status,
    fields.reviewer_handoff ?? null,
    fields.override_reason ?? null,
    metadata_json_value,
    lane_id,
  );
  if (changes.changes === 0) {
    const existing = db
      .query<{ lane_id: string }, [string]>(`SELECT lane_id FROM lane_ledger WHERE lane_id=?`)
      .get(lane_id);
    if (existing) {
      throw new Error(`conflict: lane ${lane_id} is already closed`);
    }
    throw new Error(`not found: lane ${lane_id}`);
  }
  stampAgentPerformanceGateOutcome(db, lane_id, fields.gate_status, log, true);
}

export function getLane(db: Database, lane_id: string): LaneRow | null {
  const row = db
    .query<
      {
        lane_id: string;
        ts_opened: string;
        ts_closed: string | null;
        task_class: string;
        implementer_handoff: string;
        reviewer_handoff: string | null;
        gate_status: string;
        recalled_memory_ids: string;
        recalled_query: string | null;
        override_reason: string | null;
        metadata_json: string;
      },
      [string]
    >(`SELECT * FROM lane_ledger WHERE lane_id=?`)
    .get(lane_id);
  return row ? parseLaneRow(row) : null;
}

export function getOpenLaneForImplementer(
  db: Database,
  implementer_handoff: string,
): LaneRow | null {
  const row = db
    .query<
      {
        lane_id: string;
        ts_opened: string;
        ts_closed: string | null;
        task_class: string;
        implementer_handoff: string;
        reviewer_handoff: string | null;
        gate_status: string;
        recalled_memory_ids: string;
        recalled_query: string | null;
        override_reason: string | null;
        metadata_json: string;
      },
      [string]
    >(
      `SELECT * FROM lane_ledger
       WHERE implementer_handoff=? AND ts_closed IS NULL
       ORDER BY ts_opened DESC
       LIMIT 1`,
    )
    .get(implementer_handoff);
  return row ? parseLaneRow(row) : null;
}

export function getClosedLaneRoundCountForHandoffLineage(
  db: Database,
  implementer_handoff: string,
): number {
  const row = db
    .query<{ count: number }, [string, string]>(
      `WITH target(root_id) AS (
         SELECT COALESCE(root_handoff_id, handoff_id)
         FROM handoffs
         WHERE handoff_id = ?
         LIMIT 1
       ),
       lineage_handoffs(handoff_id) AS (
         SELECT ?
         WHERE NOT EXISTS (SELECT 1 FROM target)
         UNION
         SELECT h.handoff_id
         FROM handoffs AS h
         JOIN target ON COALESCE(h.root_handoff_id, h.handoff_id) = target.root_id
       )
       SELECT COUNT(*) AS count
       FROM lane_ledger
       WHERE ts_closed IS NOT NULL
         AND implementer_handoff IN (SELECT handoff_id FROM lineage_handoffs)`,
    )
    .get(implementer_handoff, implementer_handoff);
  return row?.count ?? 0;
}

export function recentLanes(db: Database, filter: RecentLaneFilter, limit = 50): LaneRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.gate_status) {
    where.push("gate_status = ?");
    args.push(filter.gate_status);
  }
  if (filter.task_class) {
    where.push("task_class = ?");
    args.push(filter.task_class);
  }
  if (filter.since_iso) {
    where.push("ts_opened >= ?");
    args.push(filter.since_iso);
  }
  args.push(limit);
  const sql = `SELECT * FROM lane_ledger${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ts_opened DESC LIMIT ?`;
  const rows = (
    db.query(sql) as StatementWithAll<{
      lane_id: string;
      ts_opened: string;
      ts_closed: string | null;
      task_class: string;
      implementer_handoff: string;
      reviewer_handoff: string | null;
      gate_status: string;
      recalled_memory_ids: string;
      recalled_query: string | null;
      override_reason: string | null;
      metadata_json: string;
    }>
  ).all(...args.map((arg) => String(arg)));
  return rows.map(parseLaneRow);
}
