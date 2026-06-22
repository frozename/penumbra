import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedRetire } from "@penumbra/mcp/tools/long-lived-retire";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

interface RetireRow {
  status: string;
  retired_at: number | null;
}

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

describe("long_lived_retire", () => {
  it("retires agents and stamps retired_at", () => {
    const db = new Database(":memory:");
    seed(db);

    const result = handleLongLivedRetire(db, { id: "a" });
    const row = db
      .query<RetireRow, []>("SELECT status, retired_at FROM long_lived_agents WHERE id='a'")
      .get();

    expect(result.id).toBe("a");
    expect(result.status).toBe("retired");
    expect(typeof result.retired_at).toBe("number");
    expect(row?.status).toBe("retired");
    expect(row?.retired_at).toBe(result.retired_at);
  });
});
