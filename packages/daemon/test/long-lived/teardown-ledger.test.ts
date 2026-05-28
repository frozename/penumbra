import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, applySchema } from "@penumbra/core";
import { handleTickTeardown } from "../../src/long-lived/teardown.js";

describe("handleTickTeardown ledger write", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    db.query(
      `INSERT INTO long_lived_agents (
        id, display_name, schedule_cron, subscriptions_json, mcp_allowlist_json,
        bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
        circuit_breaker_threshold, standing_brief, consecutive_failures, status,
        working_memory_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("a", "a", "*/15 * * * *", "[]", "[]", 1000, 1, 0, 3, "x", 0, "active", "{}", 1, 1);
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'cron', 1)",
    ).run();
  });

  it("writes a long_lived agent_performance row", () => {
    handleTickTeardown(db, {
      tick_id: "t1",
      agent_id: "a",
      outcome: "failed",
      error: "boom",
      now: 100,
    });

    const row = db.query<any, []>(`SELECT * FROM agent_performance WHERE handoff_id='t1'`).get();
    expect(row?.agent_kind).toBe("long_lived");
    expect(row?.handoff_id).toBe("t1");
    expect(row?.notes).toBe("boom");
  });
});
