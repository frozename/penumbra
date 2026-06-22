import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedStateGet } from "@penumbra/mcp/tools/long-lived-state-get";
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

describe("long_lived_state_get", () => {
  it("returns the agent working memory", () => {
    const db = new Database(":memory:");
    seed(db);
    const result = handleLongLivedStateGet(db, { id: "a" });
    expect(result.working_memory.version).toBe(1);
  });
});
