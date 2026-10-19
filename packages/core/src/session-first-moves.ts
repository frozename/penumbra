import type { Database } from "bun:sqlite";

import type { OpenPr, OpenPrsResult } from "./open-prs.js";

export type GateDeltas = { filtered: number | null; neardup: number | null };

export type PinShare = {
  role_24h: number | null;
  pinned_24h: number | null;
  role_7d: number | null;
  pinned_7d: number | null;
  steerable_role_7d: number | null;
  steerable_pinned_7d: number | null;
};

export type SessionOpenPr = OpenPr & { not_from_known_lane: boolean | null };

export type SessionOpenPrs = { prs: SessionOpenPr[]; reason: null } | { prs: null; reason: string };

export type SessionFirstMoves = {
  git_status_dirty_count: number | null;
  head_sha: string | null;
  origin_main_sha: string | null;
  daemon_pid: number | null;
  daemon_healthy: boolean;
  worker_count: number | null;
  worker_pids: number[];
  pending_handoffs: number | null;
  pending_task_drafts: number | null;
  gate_deltas: GateDeltas;
  pin_share: PinShare | null;
  open_lanes: number | null;
  open_prs: SessionOpenPrs;
};

export type CollectSessionFirstMovesInput = {
  db: Database;
  git_status_dirty_count?: number | null;
  head_sha?: string | null;
  origin_main_sha?: string | null;
  daemon_pid?: number | null;
  daemon_healthy?: boolean;
  worker_count?: number | null;
  worker_pids?: number[];
  pending_handoffs?: number | null;
  pending_task_drafts?: number | null;
  project_id?: string | null;
  open_lanes?: number | null;
  open_prs?: OpenPrsResult;
};

function readCount(db: Database, sql: string): number | null {
  try {
    const row = db.query<{ c: number }, []>(sql).get();
    return row?.c ?? null;
  } catch {
    return null;
  }
}

function readGateDeltas(db: Database): GateDeltas {
  return {
    filtered: readCount(
      db,
      "SELECT COUNT(*) AS c FROM t1_rollups WHERE promotion_filtered_at IS NOT NULL",
    ),
    neardup: readCount(
      db,
      "SELECT COUNT(*) AS c FROM dream_actions WHERE json_extract(payload_json,'$.source') = 't2_promotion_near_dup_gate' AND status IN ('queued', 'approved', 'auto_applied')",
    ),
  };
}

function readPinShare(db: Database): PinShare | null {
  try {
    // handoffs.ts is stored as ISO text; datetime() uses a space separator that sorts before stored 'T'.
    return (
      db
        .query<
          PinShare,
          []
        >(`SELECT SUM(CASE WHEN ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') AND routing_resolution_reason='role_route' THEN 1 ELSE 0 END) AS role_24h, SUM(CASE WHEN ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') AND routing_resolution_reason IS NULL THEN 1 ELSE 0 END) AS pinned_24h, SUM(CASE WHEN routing_resolution_reason='role_route' THEN 1 ELSE 0 END) AS role_7d, SUM(CASE WHEN routing_resolution_reason IS NULL THEN 1 ELSE 0 END) AS pinned_7d, SUM(CASE WHEN COALESCE(dispatch_kind,'mcp') IN ('mcp','workflow') AND routing_resolution_reason='role_route' THEN 1 ELSE 0 END) AS steerable_role_7d, SUM(CASE WHEN COALESCE(dispatch_kind,'mcp') IN ('mcp','workflow') AND routing_resolution_reason IS NULL THEN 1 ELSE 0 END) AS steerable_pinned_7d FROM handoffs WHERE ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')`)
        .get() ?? null
    );
  } catch {
    return null;
  }
}

function readPendingTaskDrafts(db: Database, projectId: string | null | undefined): number | null {
  if (!projectId) return null;
  try {
    const row = db
      .query<{ c: number }, [string]>(
        `WITH ranked AS (
       SELECT
         event_type,
         ROW_NUMBER() OVER (
           PARTITION BY json_extract(payload_json, '$.draft_id')
           ORDER BY ingest_ts DESC, ts DESC, event_id DESC
         ) AS rn
       FROM t0_events
       WHERE event_type IN (
         'task_draft','task_draft_refining','task_draft_promoted',
         'task_draft_stale','task_draft_duplicate','task_draft_escalation'
       )
         AND project_id = ?
         AND json_valid(payload_json)
         AND json_extract(payload_json, '$.draft_id') IS NOT NULL
     )
     SELECT COUNT(*) AS c FROM ranked WHERE rn = 1 AND event_type = 'task_draft'`,
      )
      .get(projectId);
    return row?.c ?? null;
  } catch {
    return null;
  }
}

// Handoff worktrees push resolveHandoffBranchName(): branch_name, or agent/<handoff_id> for legacy rows.
function readKnownLaneHeads(db: Database, heads: string[]): Set<string> | null {
  try {
    const rows = db
      .query<{ head: string }, [string]>(
        `SELECT branch_name AS head FROM handoffs
          WHERE branch_name IN (SELECT value FROM json_each(?1))
         UNION
         SELECT 'agent/' || handoff_id AS head FROM handoffs
          WHERE branch_name IS NULL
            AND handoff_id IN (
              SELECT substr(value, 7) FROM json_each(?1) WHERE value LIKE 'agent/%'
            )`,
      )
      .all(JSON.stringify(heads));
    return new Set(rows.map((row) => row.head));
  } catch {
    return null;
  }
}

function markOpenPrLanes(db: Database, openPrs: OpenPrsResult | undefined): SessionOpenPrs {
  if (!openPrs) return { prs: null, reason: "not collected" };
  if (openPrs.prs === null) return openPrs;
  const known = readKnownLaneHeads(
    db,
    openPrs.prs.map((pr) => pr.head_ref),
  );
  return {
    prs: openPrs.prs.map((pr) => ({
      ...pr,
      not_from_known_lane: known === null ? null : !known.has(pr.head_ref),
    })),
    reason: null,
  };
}

export function collectSessionFirstMoves(input: CollectSessionFirstMovesInput): SessionFirstMoves {
  const workerPids = input.worker_pids ?? [];
  const workerCount = Object.hasOwn(input, "worker_count") ? input.worker_count : workerPids.length;
  return {
    git_status_dirty_count: input.git_status_dirty_count ?? null,
    head_sha: input.head_sha ?? null,
    origin_main_sha: input.origin_main_sha ?? null,
    daemon_pid: input.daemon_pid ?? null,
    // PID presence only; this does not call the daemon health endpoint.
    daemon_healthy: input.daemon_healthy ?? input.daemon_pid !== null,
    worker_count: workerCount ?? null,
    worker_pids: workerPids,
    pending_handoffs:
      input.pending_handoffs ??
      readCount(input.db, "SELECT COUNT(*) AS c FROM handoffs WHERE status='pending'"),
    pending_task_drafts:
      input.pending_task_drafts ?? readPendingTaskDrafts(input.db, input.project_id),
    gate_deltas: readGateDeltas(input.db),
    pin_share: readPinShare(input.db),
    open_lanes:
      input.open_lanes ??
      readCount(input.db, "SELECT COUNT(*) AS c FROM lane_ledger WHERE gate_status='open'"),
    open_prs: markOpenPrLanes(input.db, input.open_prs),
  };
}
