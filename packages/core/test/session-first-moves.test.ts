import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import type { OpenPr } from "@src/open-prs.js";
import { collectSessionFirstMoves } from "@src/session-first-moves.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

test("collectSessionFirstMoves reads gate deltas and pin share from the injected db and returns the documented shape", () => {
  const db = freshDb();
  try {
    db.run(`
      INSERT INTO t1_rollups (
        rollup_id, project_id, user_id, session_id, started_at, n_events, source_event_ids, promotion_filtered_at
      )
      VALUES ('r1', 'penumbra', 'u1', 's1', '2026-05-01', 1, '[]', '2026-05-01')
    `);
    db.run(`
      INSERT INTO dream_cycles(cycle_id, started_at, trigger, outcome, budget_usd_cap)
      VALUES ('c1', 0, 'test', 'running', 0)
    `);
    db.run(`
      INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
      VALUES ('a1', 'c1', 'review', 'promote_t1', 0.9, 'queued', '[]', '{"source":"t2_promotion_near_dup_gate"}')
    `);
    db.run(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, routing_resolution_reason, dispatch_kind)
      VALUES
        ('h-role', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'), 'c1', 'maestro', 'worker', 'role routed', 'pending', 'role_route', 'workflow'),
        ('h-pinned', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours'), 'c2', 'maestro', 'worker', 'pinned', 'dispatched', NULL, 'mcp')
    `);
    db.run(`
      INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, session_id, event_type, lane, payload_json)
      VALUES ('e1', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'test', 'penumbra', 'u1', 'm1', 's1', 'task_draft', 'system', '{"draft_id":"d1"}')
    `);
    db.run(`
      INSERT INTO lane_ledger(lane_id, ts_opened, task_class, implementer_handoff, gate_status)
      VALUES ('lane-1', '2026-05-01T00:00:00.000Z', 'STANDARD', 'h-role', 'open')
    `);

    const result = collectSessionFirstMoves({
      db,
      git_status_dirty_count: 2,
      head_sha: "head",
      origin_main_sha: "origin",
      daemon_pid: 123,
      daemon_healthy: true,
      worker_count: 4,
      project_id: "penumbra",
    });

    expect(result).toEqual({
      git_status_dirty_count: 2,
      head_sha: "head",
      origin_main_sha: "origin",
      daemon_pid: 123,
      daemon_healthy: true,
      worker_count: 4,
      worker_pids: [],
      pending_handoffs: 1,
      pending_task_drafts: 1,
      gate_deltas: { filtered: 1, neardup: 1 },
      pin_share: {
        role_24h: 1,
        pinned_24h: 1,
        role_7d: 1,
        pinned_7d: 1,
        steerable_role_7d: 1,
        steerable_pinned_7d: 1,
      },
      open_lanes: 1,
      open_prs: { prs: null, reason: "not collected" },
    });
  } finally {
    db.close();
  }
});

test("collectSessionFirstMoves preserves unknown worker count and null pin-share aggregates", () => {
  const db = freshDb();
  try {
    const result = collectSessionFirstMoves({
      db,
      worker_count: null,
      worker_pids: [],
    });

    expect(result.worker_count).toBeNull();
    expect(result.pin_share).toEqual({
      role_24h: null,
      pinned_24h: null,
      role_7d: null,
      pinned_7d: null,
      steerable_role_7d: null,
      steerable_pinned_7d: null,
    });
  } finally {
    db.close();
  }
});

test("pin_share windows compare ISO timestamps, not datetime() text", () => {
  const db = freshDb();
  try {
    db.run(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, routing_resolution_reason, dispatch_kind)
      VALUES
        ('h-24h-outside', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day','-1 minute'), 'c1', 'maestro', 'worker', '24h outside', 'pending', 'role_route', 'workflow'),
        ('h-24h-inside', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day','+1 minute'), 'c2', 'maestro', 'worker', '24h inside', 'pending', 'role_route', 'workflow'),
        ('h-7d-outside', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days','-1 minute'), 'c3', 'maestro', 'worker', '7d outside', 'pending', 'role_route', 'workflow'),
        ('h-7d-inside', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days','+1 minute'), 'c4', 'maestro', 'worker', '7d inside', 'pending', 'role_route', 'workflow')
    `);

    const result = collectSessionFirstMoves({ db });

    // During the first minute after midnight UTC, the buggy datetime() comparison can coincidentally pass.
    expect(result.pin_share?.role_24h).toBe(1);
    expect(result.pin_share?.role_7d).toBe(3);
  } finally {
    db.close();
  }
});

test("collectSessionFirstMoves filters pending task drafts by project_id", () => {
  const db = freshDb();
  try {
    db.run(`
      INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, session_id, event_type, lane, payload_json)
      VALUES
        ('e-penumbra', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'test', 'penumbra', 'u1', 'm1', 's1', 'task_draft', 'system', '{"draft_id":"d-penumbra"}'),
        ('e-sibling', '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z', 'test', 'sibling', 'u1', 'm1', 's1', 'task_draft', 'system', '{"draft_id":"d-sibling"}')
    `);

    const result = collectSessionFirstMoves({
      db,
      project_id: "penumbra",
    });

    expect(result.pending_task_drafts).toBe(1);
  } finally {
    db.close();
  }
});

function openPr(number: number, head_ref: string): OpenPr {
  return {
    number,
    title: `PR ${String(number)}`,
    head_ref,
    author: "someone",
    created_at: "2026-09-21T10:00:00Z",
    checks: "success",
    foreign_author: number === 74,
  };
}

test("collectSessionFirstMoves marks open PRs whose head branch no handoff produced", () => {
  const db = freshDb();
  try {
    db.run(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, branch_name)
      VALUES
        ('h-named', '2026-09-21T09:00:00.000Z', 'c1', 'maestro', 'worker', 'named', 'completed', 'fix/issue-71_abcd1234'),
        ('h-legacy', '2026-09-21T09:00:00.000Z', 'c2', 'maestro', 'worker', 'legacy', 'completed', NULL),
        ('h-renamed', '2026-09-21T09:00:00.000Z', 'c3', 'maestro', 'worker', 'renamed', 'completed', 'feat/renamed_ef567890')
    `);

    const result = collectSessionFirstMoves({
      db,
      open_prs: {
        prs: [
          openPr(74, "feat/other-account"),
          openPr(78, "fix/issue-71_abcd1234"),
          openPr(79, "agent/h-legacy"),
          openPr(80, "agent/h-renamed"),
        ],
        reason: null,
      },
    });

    expect(result.open_prs).toEqual({
      reason: null,
      prs: [
        { ...openPr(74, "feat/other-account"), not_from_known_lane: true },
        { ...openPr(78, "fix/issue-71_abcd1234"), not_from_known_lane: false },
        { ...openPr(79, "agent/h-legacy"), not_from_known_lane: false },
        { ...openPr(80, "agent/h-renamed"), not_from_known_lane: true },
      ],
    });
  } finally {
    db.close();
  }
});

test("collectSessionFirstMoves leaves the lane mark null when handoffs cannot be read", () => {
  const db = new Database(":memory:");
  try {
    const result = collectSessionFirstMoves({
      db,
      open_prs: { prs: [openPr(74, "feat/other-account")], reason: null },
    });

    expect(result.open_prs).toEqual({
      reason: null,
      prs: [{ ...openPr(74, "feat/other-account"), not_from_known_lane: null }],
    });
  } finally {
    db.close();
  }
});

test("collectSessionFirstMoves passes an unavailable open-PR result through with its reason", () => {
  const db = freshDb();
  try {
    const result = collectSessionFirstMoves({
      db,
      open_prs: { prs: null, reason: "gh not installed" },
    });

    expect(result.open_prs).toEqual({ prs: null, reason: "gh not installed" });
  } finally {
    db.close();
  }
});
