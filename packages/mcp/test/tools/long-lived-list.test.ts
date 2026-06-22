import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedList } from "@penumbra/mcp/tools/long-lived-list";
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
        name: "active-agent",
        display_name: "Active Agent",
        schedule_cron: "*/15 * * * *",
      }),
      buildLongLivedAgentFixture({
        name: "retired-agent",
        display_name: "Retired Agent",
        schedule_cron: "*/15 * * * *",
        standing_brief: "y",
      }),
    ],
    { now: 1 },
  );
  db.query(
    "UPDATE long_lived_agents SET status='retired', retired_at=2 WHERE id='retired-agent'",
  ).run();
}

describe("long_lived_list", () => {
  it("lists only non-retired agents", () => {
    const db = new Database(":memory:");
    seed(db);

    const result = handleLongLivedList(db, {});

    expect(result.agents).toEqual([
      { id: "active-agent", display_name: "Active Agent", status: "active" },
    ]);
  });
});
