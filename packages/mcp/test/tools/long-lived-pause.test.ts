import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedPause } from "@penumbra/mcp/tools/long-lived-pause";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

function seed(db: Database): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      buildLongLivedAgentFixture({
        name: "a",
        display_name: "A",
        schedule_cron: "*/15 * * * *",
      }),
    ],
    { now: 1 },
  );
}

describe("long_lived_pause", () => {
  it("pauses active agents", () => {
    const db = new Database(":memory:");
    seed(db);

    const result = handleLongLivedPause(db, { id: "a" });
    const row = db
      .query<{ status: string }, []>("SELECT status FROM long_lived_agents WHERE id='a'")
      .get();

    expect(result).toEqual({ id: "a", status: "paused" });
    expect(row?.status).toBe("paused");
  });

  it("rejects invalid transitions", () => {
    const db = new Database(":memory:");
    seed(db);
    db.query("UPDATE long_lived_agents SET status='retired' WHERE id='a'").run();

    expect(() => handleLongLivedPause(db, { id: "a" })).toThrow(
      /invalid_long_lived_status_transition/,
    );
  });
});
