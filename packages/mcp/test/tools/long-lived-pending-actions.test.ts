import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedPendingActions } from "@penumbra/mcp/tools/long-lived-pending-actions";

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "a",
        long_lived: true,
        long_lived_config: {
          schedule_cron: "*/1 * * * *",
          subscriptions: [],
          mcp_allowlist: [],
          bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3,
          standing_brief: "x",
        },
      } as any,
      {
        name: "b",
        long_lived: true,
        long_lived_config: {
          schedule_cron: "*/1 * * * *",
          subscriptions: [],
          mcp_allowlist: [],
          bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3,
          standing_brief: "y",
        },
      } as any,
    ],
    { now: 1 },
  );
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('ta', 'a', 'manual', 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tb', 'b', 'manual', 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa1', 'a', 'ta', 'ha:x.set', 'f', '{}', 'pending', 9999, 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa2', 'b', 'tb', 'ha:x.set', 'f', '{}', 'approved', 9999, 2)",
  ).run();
}

describe("long_lived_pending_actions", () => {
  it("lists pending actions and filters by agent id and status", async () => {
    const db = new Database(":memory:");
    seed(db);

    const allPending = await handleLongLivedPendingActions(db, { id: null, status: "pending" });
    expect(allPending.pending_actions.map((row: any) => row.id)).toEqual(["pa1"]);

    const agentPending = await handleLongLivedPendingActions(db, { id: "b", status: "approved" });
    expect(agentPending.pending_actions.map((row: any) => row.id)).toEqual(["pa2"]);
  });
});
