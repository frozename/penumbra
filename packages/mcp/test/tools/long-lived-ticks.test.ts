import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedTicks } from "@penumbra/mcp/tools/long-lived-ticks";

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
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'manual', 100)",
  ).run();
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t2', 'a', 'cron', 200)",
  ).run();
}

describe("long_lived_ticks", () => {
  it("filters by since and limit", async () => {
    const db = new Database(":memory:");
    seed(db);

    const result = await handleLongLivedTicks(db, { id: "a", since: 150, limit: 1 });

    expect(result.ticks).toHaveLength(1);
    expect(result.ticks[0].id).toBe("t2");
  });

  it("defaults limit to 50", async () => {
    const db = new Database(":memory:");
    seed(db);

    const result = await handleLongLivedTicks(db, { id: "a" });
    expect(result.ticks).toHaveLength(2);
  });
});
