import { handleLongLivedSelfStateSet } from "@penumbra/mcp/tools/long-lived-self-state-set";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import {
  insertLongLivedTick,
  reconcileLongLivedTestAgents,
  seedLongLivedAgent,
} from "./long-lived-fixtures.js";

function seedDb(): Database {
  const db = new Database(":memory:");
  seedLongLivedAgent(db, { name: "a", standing_brief: "x" });
  insertLongLivedTick(db, { tick_id: "tick-a", agent_id: "a" });
  return db;
}

function readIntent(db: Database, id: string): string | null {
  const row = db
    .query<
      { last_intent_summary: string | null },
      [string]
    >("SELECT last_intent_summary FROM long_lived_agents WHERE id=?")
    .get(id);
  return row?.last_intent_summary ?? null;
}

interface ParsedWorkingMemory {
  open_threads: { id: string; topic: string; opened_at: number; notes: string }[];
}

function readWorkingMemory(db: Database, id: string): ParsedWorkingMemory {
  const row = db
    .query<
      { working_memory_json: string },
      [string]
    >("SELECT working_memory_json FROM long_lived_agents WHERE id=?")
    .get(id);
  if (!row) {
    throw new Error(`agent_not_found:${id}`);
  }
  return JSON.parse(row.working_memory_json) as ParsedWorkingMemory;
}

describe("long_lived_self_state_set", () => {
  it("updates intent_summary atomically", () => {
    const db = seedDb();
    handleLongLivedSelfStateSet(
      db,
      { running_agent_id: "a", running_tick_id: "tick-a" },
      { intent_summary: "checking the dryer" },
    );
    expect(readIntent(db, "a")).toBe("checking the dryer");
  });

  it("replaces working_memory when provided (full replacement, not merge)", () => {
    const db = seedDb();
    const wm = {
      version: 1,
      updated_at: 5,
      pending_goals: [],
      open_threads: [{ id: "o1", topic: "t", opened_at: 1, notes: "" }],
      watches: [],
      recent_decisions: [],
    };
    handleLongLivedSelfStateSet(
      db,
      { running_agent_id: "a", running_tick_id: "tick-a" },
      { working_memory: wm },
    );
    expect(readWorkingMemory(db, "a").open_threads).toHaveLength(1);
  });

  it("rejects invalid working memory", () => {
    const db = seedDb();
    expect(() =>
      handleLongLivedSelfStateSet(
        db,
        { running_agent_id: "a", running_tick_id: "tick-a" },
        { working_memory: { version: 99 } },
      ),
    ).toThrow();
  });

  it("errors when not in a running tick", () => {
    const db = seedDb();
    expect(() => handleLongLivedSelfStateSet(db, {}, { intent_summary: "x" })).toThrow(
      /no_running_long_lived_tick/,
    );
  });

  it("errors with cross_identity_long_lived when tick belongs to another agent", () => {
    const db = seedDb();
    reconcileLongLivedTestAgents(db, [
      { name: "a", standing_brief: "x" },
      { name: "b", standing_brief: "y" },
    ]);
    insertLongLivedTick(db, { tick_id: "tick-b", agent_id: "b" });
    expect(() =>
      handleLongLivedSelfStateSet(
        db,
        { running_agent_id: "a", running_tick_id: "tick-b" },
        { intent_summary: "x" },
      ),
    ).toThrow(/cross_identity_long_lived/);
  });
});
