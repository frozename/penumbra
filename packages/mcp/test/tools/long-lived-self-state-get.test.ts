import { handleLongLivedSelfStateGet } from "@penumbra/mcp/tools/long-lived-self-state-get";
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

describe("long_lived_self_state_get", () => {
  it("returns the running agent's working memory", () => {
    const db = seedDb();
    const result = handleLongLivedSelfStateGet(
      db,
      { running_agent_id: "a", running_tick_id: "tick-a" },
      {},
    );
    expect(result.working_memory.version).toBe(1);
    expect(result.working_memory.pending_goals).toEqual([]);
  });

  it("errors when running_agent_id is missing", () => {
    const db = seedDb();
    expect(() => handleLongLivedSelfStateGet(db, {}, {})).toThrow(/no_running_long_lived_tick/);
  });

  it("errors when running_tick_id is missing", () => {
    const db = seedDb();
    expect(() => handleLongLivedSelfStateGet(db, { running_agent_id: "a" }, {})).toThrow(
      /no_running_long_lived_tick/,
    );
  });

  it("errors with unknown_long_lived_tick when running_tick_id does not exist", () => {
    const db = seedDb();
    expect(() =>
      handleLongLivedSelfStateGet(
        db,
        { running_agent_id: "a", running_tick_id: "tick-missing" },
        {},
      ),
    ).toThrow(/unknown_long_lived_tick/);
  });

  it("errors with cross_identity_long_lived when tick belongs to another agent", () => {
    const db = seedDb();
    reconcileLongLivedTestAgents(db, [
      { name: "a", standing_brief: "x" },
      { name: "b", standing_brief: "y" },
    ]);
    insertLongLivedTick(db, { tick_id: "tick-b", agent_id: "b" });
    expect(() =>
      handleLongLivedSelfStateGet(db, { running_agent_id: "a", running_tick_id: "tick-b" }, {}),
    ).toThrow(/cross_identity_long_lived/);
  });

  it("errors with tick_terminal_status_set when tick is already terminal", () => {
    const db = seedDb();
    db.query(
      "UPDATE long_lived_ticks SET outcome='failed', completed_at=2 WHERE id='tick-a'",
    ).run();
    expect(() =>
      handleLongLivedSelfStateGet(db, { running_agent_id: "a", running_tick_id: "tick-a" }, {}),
    ).toThrow(/tick_terminal_status_set/);
  });
});
