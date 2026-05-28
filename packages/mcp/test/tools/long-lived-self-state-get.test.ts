import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedSelfStateGet } from "@penumbra/mcp/tools/long-lived-self-state-get";

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
          schedule_cron: "*/15 * * * *",
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
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-a', 'a', 'manual', 1)",
  ).run();
}

describe("long_lived_self_state_get", () => {
  it("returns the running agent's working memory", async () => {
    const db = new Database(":memory:");
    seed(db);
    const result = await handleLongLivedSelfStateGet(
      db,
      { running_agent_id: "a", running_tick_id: "tick-a" },
      {},
    );
    expect(result.working_memory.version).toBe(1);
    expect(result.working_memory.pending_goals).toEqual([]);
  });

  it("errors when running_agent_id is missing", async () => {
    const db = new Database(":memory:");
    seed(db);
    await expect(handleLongLivedSelfStateGet(db, {}, {})).rejects.toThrow(
      /no_running_long_lived_tick/,
    );
  });

  it("errors when running_tick_id is missing", async () => {
    const db = new Database(":memory:");
    seed(db);
    await expect(handleLongLivedSelfStateGet(db, { running_agent_id: "a" }, {})).rejects.toThrow(
      /no_running_long_lived_tick/,
    );
  });

  it("errors with unknown_long_lived_tick when running_tick_id does not exist", async () => {
    const db = new Database(":memory:");
    seed(db);
    await expect(
      handleLongLivedSelfStateGet(
        db,
        { running_agent_id: "a", running_tick_id: "tick-missing" },
        {},
      ),
    ).rejects.toThrow(/unknown_long_lived_tick/);
  });

  it("errors with cross_identity_long_lived when tick belongs to another agent", async () => {
    const db = new Database(":memory:");
    seed(db);
    reconcileLongLivedAgents(
      db,
      [
        {
          name: "b",
          long_lived: true,
          long_lived_config: {
            schedule_cron: "*/15 * * * *",
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
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-b', 'b', 'manual', 1)",
    ).run();
    await expect(
      handleLongLivedSelfStateGet(db, { running_agent_id: "a", running_tick_id: "tick-b" }, {}),
    ).rejects.toThrow(/cross_identity_long_lived/);
  });

  it("errors with tick_terminal_status_set when tick is already terminal", async () => {
    const db = new Database(":memory:");
    seed(db);
    db.query(
      "UPDATE long_lived_ticks SET outcome='failed', completed_at=2 WHERE id='tick-a'",
    ).run();
    await expect(
      handleLongLivedSelfStateGet(db, { running_agent_id: "a", running_tick_id: "tick-a" }, {}),
    ).rejects.toThrow(/tick_terminal_status_set/);
  });
});
