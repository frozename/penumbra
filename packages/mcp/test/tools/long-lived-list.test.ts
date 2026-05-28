import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedList } from "@penumbra/mcp/tools/long-lived-list";

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "active-agent",
        display_name: "Active Agent",
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
      {
        name: "retired-agent",
        display_name: "Retired Agent",
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
    "UPDATE long_lived_agents SET status='retired', retired_at=2 WHERE id='retired-agent'",
  ).run();
}

describe("long_lived_list", () => {
  it("lists only non-retired agents", async () => {
    const db = new Database(":memory:");
    seed(db);

    const result = await handleLongLivedList(db, {});

    expect(result.agents).toEqual([
      { id: "active-agent", display_name: "Active Agent", status: "active" },
    ]);
  });
});
