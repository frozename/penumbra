import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { runPendingExpiry } from "@penumbra/daemon/long-lived/pending-expiry";

function setup() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "home",
        long_lived: true,
        long_lived_config: {
          schedule_cron: "*/15 * * * *",
          subscriptions: [],
          mcp_allowlist: ["ha:light.*"],
          bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3,
          standing_brief: "x",
        },
      } as any,
    ],
    { now: 100 },
  );
  return db;
}

describe("runPendingExpiry", () => {
  it("expires overdue pending actions and records an expired decision", () => {
    const db = setup();
    db.query(
      `
      INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at)
      VALUES ('tick-1', 'home', 'manual', 100)
    `,
    ).run();
    db.query(
      `
      INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json,
        status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
    ).run("pa-expired", "home", "tick-1", "ha:light.turn_on", "light.kitchen", "{}", 50, 100);
    db.query(
      `
      INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json,
        status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
    ).run("pa-future", "home", "tick-1", "ha:light.turn_off", "light.office", "{}", 150, 100);

    const result = runPendingExpiry(db, { now: 100 });

    expect(result.expired).toBe(1);

    const expired = db
      .query("SELECT status, decided_by FROM long_lived_pending_actions WHERE id='pa-expired'")
      .get() as any;
    expect(expired.status).toBe("expired");
    expect(expired.decided_by).toBe("auto-expired");

    const future = db
      .query("SELECT status, decided_by FROM long_lived_pending_actions WHERE id='pa-future'")
      .get() as any;
    expect(future.status).toBe("pending");
    expect(future.decided_by).toBeNull();

    const wm = db
      .query("SELECT working_memory_json FROM long_lived_agents WHERE id='home'")
      .get() as any;
    const parsed = JSON.parse(wm.working_memory_json);
    expect(parsed.recent_decisions).toEqual([
      { pending_action_id: "pa-expired", decision: "expired", decided_at: 100 },
    ]);
    expect(parsed.updated_at).toBe(100);
  });
});
