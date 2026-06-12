import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getHandoffToAgent } from "../../src/db/handoffs.js";

describe("handoffs dao", () => {
  test("returns the destination agent for a handoff", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE handoffs (
        handoff_id TEXT PRIMARY KEY,
        to_agent TEXT NOT NULL
      );
    `);
    db.run("INSERT INTO handoffs (handoff_id, to_agent) VALUES (?, ?)", ["h-1", "codex"]);

    expect(getHandoffToAgent(db, "h-1")).toBe("codex");
    expect(getHandoffToAgent(db, "missing")).toBeNull();
  });
});
