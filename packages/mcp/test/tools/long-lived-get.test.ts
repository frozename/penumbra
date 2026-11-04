import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedAudit } from "@penumbra/mcp/tools/long-lived-audit";
import { handleLongLivedGet } from "@penumbra/mcp/tools/long-lived-get";
import { handleLongLivedPendingActions } from "@penumbra/mcp/tools/long-lived-pending-actions";
import { handleLongLivedRejectAction } from "@penumbra/mcp/tools/long-lived-reject-action";
import { handleLongLivedTicks } from "@penumbra/mcp/tools/long-lived-ticks";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

interface RecentTickRow {
  trigger_payload: unknown;
}

interface PendingActionRow {
  payload: unknown;
}

interface AuditRow {
  decision: string;
}

interface WorkingMemoryShape {
  version: number;
}

function seed(db: Database): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      buildLongLivedAgentFixture({
        name: "operator1",
        display_name: "Operator One",
        schedule_cron: "*/15 * * * *",
        standing_brief: "watch the lanes",
        subscriptions: [{ server: "lanes", event: "state_changed" }],
        mcp_allowlist: ["lanes:state.*"],
      }),
    ],
    { now: 1 },
  );
}

describe("long_lived_get", () => {
  it("returns full agent detail with recent related rows", () => {
    const db = new Database(":memory:");
    seed(db);
    db.query(
      `INSERT INTO long_lived_ticks (
        id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
        completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "tick-1",
      "operator1",
      "chain-1",
      "cron",
      JSON.stringify({ scheduled: true }),
      "check the lanes",
      1000,
      2000,
      "success",
      12,
      null,
      JSON.stringify({}),
    );
    db.query(
      `INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
        status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "action-1",
      "operator1",
      "tick-1",
      "notify",
      "lanes:state",
      JSON.stringify({ message: "ping" }),
      "needs attention",
      "pending",
      999999,
      null,
      null,
      null,
      1500,
    );
    db.query(
      `INSERT INTO long_lived_action_audit (
        agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("operator1", "tick-1", "action-1", "notify", "lanes:state", "approved", null, 1600);

    const result = handleLongLivedGet(db, { id: "operator1" });

    expect(result.agent.id).toBe("operator1");
    expect((result.agent.working_memory as WorkingMemoryShape).version).toBe(1);
    expect(result.recent_ticks).toHaveLength(1);
    expect((result.recent_ticks[0] as RecentTickRow).trigger_payload).toEqual({ scheduled: true });
    expect((result.pending_actions[0] as PendingActionRow).payload).toEqual({ message: "ping" });
    expect((result.recent_audit[0] as AuditRow).decision).toBe("approved");
  });

  it("keeps a retired home-mgmt row and its history readable", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    db.query(
      `INSERT INTO long_lived_agents (
        id, display_name, status, retired_at, working_memory_json, standing_brief,
        mcp_allowlist_json, created_at, updated_at
      ) VALUES (?, ?, 'retired', ?, ?, ?, ?, ?, ?)`,
    ).run(
      "home-mgmt",
      "Home management",
      500,
      JSON.stringify({
        version: 1,
        updated_at: 1,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "legacy",
      '["ha:state.*"]',
      1,
      1,
    );
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at, completed_at, outcome)
       VALUES ('legacy-tick', 'home-mgmt', 'cron', 100, 200, 'success')`,
    ).run();
    db.query(
      `INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json,
        status, expires_at, created_at
      ) VALUES ('legacy-action', 'home-mgmt', 'legacy-tick', 'notify', 'ha:state', '{}',
        'pending', 999999, 150)`,
    ).run();
    db.query(
      `INSERT INTO long_lived_action_audit (
        agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
      ) VALUES ('home-mgmt', 'legacy-tick', 'legacy-action', 'notify', 'ha:state', 'approved', null, 160)`,
    ).run();

    const result = handleLongLivedGet(db, { id: "home-mgmt" });

    expect(result.agent.id).toBe("home-mgmt");
    expect(result.agent.status).toBe("retired");
    expect(result.recent_ticks).toHaveLength(1);
    expect(result.pending_actions).toHaveLength(1);
    expect(result.recent_audit).toHaveLength(1);
    expect(handleLongLivedAudit(db, { id: "home-mgmt" }).audit).toHaveLength(1);
    expect(handleLongLivedTicks(db, { id: "home-mgmt" }).ticks).toHaveLength(1);
    expect(handleLongLivedPendingActions(db, { id: "home-mgmt" }).pending_actions).toHaveLength(1);

    handleLongLivedRejectAction(
      db,
      { emit: () => undefined, now: () => 700 },
      { action_id: "legacy-action", reason: "operator retired" },
    );

    expect(
      db
        .query<
          { status: string },
          [string]
        >("SELECT status FROM long_lived_pending_actions WHERE id=?")
        .get("legacy-action"),
    ).toEqual({ status: "rejected" });
    const audit = handleLongLivedAudit(db, { id: "home-mgmt" }).audit as AuditRow[];
    expect(audit).toHaveLength(2);
    expect(audit[0]?.decision).toBe("rejected");
    expect(
      db
        .query<{ status: string }, [string]>("SELECT status FROM long_lived_agents WHERE id=?")
        .get("home-mgmt"),
    ).toEqual({ status: "retired" });
  });

  it("rejects missing ids", () => {
    const db = new Database(":memory:");
    seed(db);
    expect(() => handleLongLivedGet(db, {})).toThrow();
  });
});
