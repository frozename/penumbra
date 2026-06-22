import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedStateSet } from "@penumbra/mcp/tools/long-lived-state-set";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

interface StateRow {
  last_intent_summary: string | null;
  working_memory_json: string;
}

interface WorkingMemoryDoc {
  updated_at: number;
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

describe("long_lived_state_set", () => {
  it("updates intent summary and working memory atomically", () => {
    const db = new Database(":memory:");
    seed(db);
    const wm = {
      version: 1 as const,
      updated_at: 5,
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    };

    handleLongLivedStateSet(db, {
      id: "a",
      partial: { intent_summary: "checking", working_memory: wm },
    });

    const row = db
      .query<
        StateRow,
        []
      >("SELECT last_intent_summary, working_memory_json FROM long_lived_agents WHERE id='a'")
      .get();
    expect(row?.last_intent_summary).toBe("checking");
    const parsed = JSON.parse(row?.working_memory_json ?? "{}") as WorkingMemoryDoc;
    expect(parsed.updated_at).toBeGreaterThan(0);
  });
});
