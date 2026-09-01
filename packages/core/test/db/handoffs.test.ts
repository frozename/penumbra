import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { getHandoffToAgent } from "@src/db/handoffs.js";
import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { HandoffReader } from "@src/readers/handoff.js";
import { HandoffWriter } from "@src/writers/handoff.js";

describe("handoffs dao", () => {
  test("returns the destination agent for a handoff", () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE handoffs (
        handoff_id TEXT PRIMARY KEY,
        to_agent TEXT NOT NULL
      );
    `);
    db.run("INSERT INTO handoffs (handoff_id, to_agent) VALUES (?, ?)", ["h-1", "codex"]);

    expect(getHandoffToAgent(db, "h-1")).toBe("codex");
    expect(getHandoffToAgent(db, "missing")).toBeNull();
  });

  test("HandoffWriter.create persists branch_base and chain_max_hops", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new HandoffWriter({ db });
    const reader = new HandoffReader({ db });

    writer.create({
      handoff_id: "h-next",
      ts: "2026-09-01T12:00:00.000Z",
      from: "planner",
      to: "executor",
      message: "continue",
      conversation_id: "conv-1",
      project_id: null,
      triggered_by_event_id: "evt-1",
      parent_handoff_id: "h-parent",
      branch_base: "feat/round-one",
      chain_max_hops: 3,
    });

    const row = reader.get("h-next");
    expect(row?.parent_handoff_id).toBe("h-parent");
    expect(row?.branch_base).toBe("feat/round-one");
    expect(row?.chain_max_hops).toBe(3);
  });
});
