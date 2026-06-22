import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedTicks } from "@penumbra/mcp/tools/long-lived-ticks";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

interface TickRow {
  id: string;
}

function seed(db: Database): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [buildLongLivedAgentFixture({ name: "a" })], { now: 1 });
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'manual', 100)",
  ).run();
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t2', 'a', 'cron', 200)",
  ).run();
}

describe("long_lived_ticks", () => {
  it("filters by since and limit", () => {
    const db = new Database(":memory:");
    seed(db);

    const result = handleLongLivedTicks(db, { id: "a", since: 150, limit: 1 });

    expect(result.ticks).toHaveLength(1);
    expect((result.ticks[0] as TickRow).id).toBe("t2");
  });

  it("defaults limit to 50", () => {
    const db = new Database(":memory:");
    seed(db);

    const result = handleLongLivedTicks(db, { id: "a" });
    expect(result.ticks).toHaveLength(2);
  });
});
