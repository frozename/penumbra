import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedGet } from "@penumbra/mcp/tools/long-lived-get";
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
        name: "home-mgmt",
        display_name: "Home Mgmt",
        schedule_cron: "*/15 * * * *",
        standing_brief: "watch home state",
        subscriptions: [{ server: "ha", event: "state_changed" }],
        mcp_allowlist: ["ha:state.*"],
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
      "home-mgmt",
      "chain-1",
      "cron",
      JSON.stringify({ scheduled: true }),
      "check the house",
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
      "home-mgmt",
      "tick-1",
      "notify",
      "ha:state",
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
    ).run("home-mgmt", "tick-1", "action-1", "notify", "ha:state", "approved", null, 1600);

    const result = handleLongLivedGet(db, { id: "home-mgmt" });

    expect(result.agent.id).toBe("home-mgmt");
    expect((result.agent.working_memory as WorkingMemoryShape).version).toBe(1);
    expect(result.recent_ticks).toHaveLength(1);
    expect((result.recent_ticks[0] as RecentTickRow).trigger_payload).toEqual({ scheduled: true });
    expect((result.pending_actions[0] as PendingActionRow).payload).toEqual({ message: "ping" });
    expect((result.recent_audit[0] as AuditRow).decision).toBe("approved");
  });

  it("rejects missing ids", () => {
    const db = new Database(":memory:");
    seed(db);
    expect(() => handleLongLivedGet(db, {})).toThrow();
  });
});
