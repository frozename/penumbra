import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  loadSqliteVec,
  readLongLivedAgentWorkingMemory,
  updateLongLivedAgentState,
  listLongLivedPendingActionsForAgent,
} from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  db.query(
    `
    INSERT INTO long_lived_agents (
      id, display_name, status, consecutive_failures, circuit_breaker_threshold,
      mcp_allowlist_json, approval_required_globs_json, cooldown_overrides_json,
      working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (
      'a', 'Agent A', 'active', 0, 3, '[]', '[]', '{}',
      '{"version":1,"updated_at":1,"pending_goals":[],"open_threads":[],"watches":[],"recent_decisions":[]}',
      'x', 1, 1
    )
  `,
  ).run();
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-a', 'a', 'manual', 1)",
  ).run();
}

describe("long-lived self reader/writer helpers", () => {
  it("reads working memory for an existing agent", () => {
    const db = new Database(":memory:");
    seed(db);
    const wm = readLongLivedAgentWorkingMemory(db, "a");
    expect(wm.version).toBe(1);
    expect(wm.pending_goals).toEqual([]);
  });

  it("throws agent_not_found for a missing agent", () => {
    const db = new Database(":memory:");
    seed(db);
    expect(() => readLongLivedAgentWorkingMemory(db, "missing")).toThrow(/agent_not_found/);
  });

  it("updates working memory and intent summary independently", () => {
    const db = new Database(":memory:");
    seed(db);
    const wm = {
      version: 1,
      updated_at: 5,
      pending_goals: [],
      open_threads: [{ id: "o1", topic: "t", opened_at: 1, notes: "" }],
      watches: [],
      recent_decisions: [],
    };
    updateLongLivedAgentState(db, "a", { working_memory: wm as any, intent_summary: "intent" });
    const row = db
      .query("SELECT last_intent_summary, working_memory_json FROM long_lived_agents WHERE id='a'")
      .get() as any;
    expect(row.last_intent_summary).toBe("intent");
    expect(JSON.parse(row.working_memory_json).open_threads).toHaveLength(1);
  });

  it("no-ops when given an empty patch", () => {
    const db = new Database(":memory:");
    seed(db);
    const before = db
      .query("SELECT last_intent_summary, working_memory_json FROM long_lived_agents WHERE id='a'")
      .get() as any;
    updateLongLivedAgentState(db, "a", {});
    const after = db
      .query("SELECT last_intent_summary, working_memory_json FROM long_lived_agents WHERE id='a'")
      .get() as any;
    expect(after).toEqual(before);
  });

  it("lists only pending actions for the agent in descending created_at order", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    db.query(
      `
      INSERT INTO long_lived_agents (
        id, display_name, status, consecutive_failures, circuit_breaker_threshold,
        mcp_allowlist_json, approval_required_globs_json, cooldown_overrides_json,
        working_memory_json, standing_brief, created_at, updated_at
      ) VALUES
        ('a', 'Agent A', 'active', 0, 3, '[]', '[]', '{}', '{"version":1,"updated_at":1,"pending_goals":[],"open_threads":[],"watches":[],"recent_decisions":[]}', 'x', 1, 1),
        ('b', 'Agent B', 'active', 0, 3, '[]', '[]', '{}', '{"version":1,"updated_at":1,"pending_goals":[],"open_threads":[],"watches":[],"recent_decisions":[]}', 'y', 1, 1)
    `,
    ).run();
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('ta', 'a', 'manual', 1)",
    ).run();
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tb', 'a', 'manual', 1)",
    ).run();
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tc', 'b', 'manual', 1)",
    ).run();
    db.query(
      "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa1', 'a', 'ta', 'ha:x.set', 'f', '{}', 'pending', 9999, 1)",
    ).run();
    db.query(
      "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa2', 'a', 'tb', 'ha:x.set', 'f', '{}', 'approved', 9999, 2)",
    ).run();
    db.query(
      "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa3', 'a', 'tb', 'ha:x.set', 'f', '{}', 'pending', 9999, 3)",
    ).run();
    db.query(
      "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pb1', 'b', 'tc', 'ha:x.set', 'f', '{}', 'pending', 9999, 4)",
    ).run();

    const rows = listLongLivedPendingActionsForAgent(db, "a");
    expect(rows.map((row) => row.id)).toEqual(["pa3", "pa1"]);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
  });
});
