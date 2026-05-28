import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedRetire } from "@penumbra/mcp/tools/long-lived-retire";

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "a",
        display_name: "A",
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
}

describe("long_lived_retire", () => {
  it("retires agents and stamps retired_at", async () => {
    const db = new Database(":memory:");
    seed(db);

    const result = await handleLongLivedRetire(db, { id: "a" });
    const row = db
      .query("SELECT status, retired_at FROM long_lived_agents WHERE id='a'")
      .get() as any;

    expect(result.id).toBe("a");
    expect(result.status).toBe("retired");
    expect(typeof result.retired_at).toBe("number");
    expect(row.status).toBe("retired");
    expect(row.retired_at).toBe(result.retired_at);
  });
});
