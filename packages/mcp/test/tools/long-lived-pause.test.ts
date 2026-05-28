import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedPause } from "@penumbra/mcp/tools/long-lived-pause";

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

describe("long_lived_pause", () => {
  it("pauses active agents", async () => {
    const db = new Database(":memory:");
    seed(db);

    const result = await handleLongLivedPause(db, { id: "a" });
    const row = db.query("SELECT status FROM long_lived_agents WHERE id='a'").get() as any;

    expect(result).toEqual({ id: "a", status: "paused" });
    expect(row.status).toBe("paused");
  });

  it("rejects invalid transitions", async () => {
    const db = new Database(":memory:");
    seed(db);
    db.query("UPDATE long_lived_agents SET status='retired' WHERE id='a'").run();

    await expect(handleLongLivedPause(db, { id: "a" })).rejects.toThrow(
      /invalid_long_lived_status_transition/,
    );
  });
});
