import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedApproveAction } from "@penumbra/mcp/tools/long-lived-approve-action";

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
    ],
    { now: 1 },
  );
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'manual', 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('p1', 'a', 't1', 'ha:integration.install', 'mqtt', '{\"domain\":\"mqtt\"}', 'pending', 9999, 1)",
  ).run();
}

describe("long_lived_approve_action", () => {
  it("marks approved, injects approved_action into working memory, and emits an event", async () => {
    const db = new Database(":memory:");
    seed(db);
    const events: any[] = [];

    const result = await handleLongLivedApproveAction(
      db,
      { emit: (event) => events.push(event), now: () => 50 },
      { action_id: "p1" },
    );

    expect(result.ok).toBe(true);
    const row = db
      .query("SELECT status, decided_by, decided_at FROM long_lived_pending_actions WHERE id='p1'")
      .get() as any;
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("user");
    expect(row.decided_at).toBe(50);

    const wm = JSON.parse(
      (db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any)
        .working_memory_json,
    );
    expect(wm.pending_goals).toHaveLength(1);
    expect(wm.pending_goals[0]).toMatchObject({
      kind: "approved_action",
      pending_action_id: "p1",
      original_payload: { domain: "mqtt" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "long_lived_action_decided",
      agent_id: "a",
      payload: { action_id: "p1", decision: "approved" },
    });
  });
});
