import {
  listLongLivedPendingActionsForAgent,
  loadSqliteVec,
  readLongLivedAgentWorkingMemory,
  updateLongLivedAgentState,
} from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { WorkingMemory } from "@src/long-lived/types.js";

interface AgentRow {
  last_intent_summary: string | null;
  working_memory_json: string;
}

interface WorkingMemoryJsonRow {
  working_memory_json: string;
}

function seed(db: Database): void {
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

function readAgent(db: Database): AgentRow {
  const row = db
    .query<
      AgentRow,
      []
    >("SELECT last_intent_summary, working_memory_json FROM long_lived_agents WHERE id='a'")
    .get();
  if (!row) throw new Error("agent row missing");
  return row;
}

function readWorkingMemory(db: Database): WorkingMemory {
  const row = db
    .query<
      WorkingMemoryJsonRow,
      []
    >("SELECT working_memory_json FROM long_lived_agents WHERE id='a'")
    .get();
  if (!row) throw new Error("agent row missing");
  return JSON.parse(row.working_memory_json) as WorkingMemory;
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

  it("returns empty working memory instead of throwing on a corrupt row", () => {
    const db = new Database(":memory:");
    seed(db);
    db.query("UPDATE long_lived_agents SET working_memory_json = ? WHERE id='a'").run("{not json");
    let wm!: WorkingMemory;
    expect(() => {
      wm = readLongLivedAgentWorkingMemory(db, "a");
    }).not.toThrow();
    expect(wm.version).toBe(1);
    expect(wm.pending_goals).toEqual([]);
    expect(wm.open_threads).toEqual([]);
  });

  it("updates working memory and intent summary independently", () => {
    const db = new Database(":memory:");
    seed(db);
    const wm: WorkingMemory = {
      version: 1,
      updated_at: 5,
      pending_goals: [],
      open_threads: [{ id: "o1", topic: "t", opened_at: 1, notes: "" }],
      watches: [],
      recent_decisions: [],
    };
    updateLongLivedAgentState(db, "a", { working_memory: wm, intent_summary: "intent" });
    const row = readAgent(db);
    expect(row.last_intent_summary).toBe("intent");
    const stored = JSON.parse(row.working_memory_json) as WorkingMemory;
    expect(stored.open_threads).toHaveLength(1);
  });

  it("no-ops when given an empty patch", () => {
    const db = new Database(":memory:");
    seed(db);
    const before = readAgent(db);
    updateLongLivedAgentState(db, "a", {});
    const after = readAgent(db);
    expect(after).toEqual(before);
  });

  it("flushes consumed pending goals when tick read snapshot omits them", () => {
    const db = new Database(":memory:");
    seed(db);
    const beforeRead: WorkingMemory = {
      version: 1,
      updated_at: 2,
      pending_goals: [{ kind: "user_goal", text: "relevant", created_at: 0 }],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    };
    db.query("UPDATE long_lived_agents SET working_memory_json = ? WHERE id='a'").run(
      JSON.stringify(beforeRead),
    );

    updateLongLivedAgentState(
      db,
      "a",
      {
        working_memory: {
          version: 1,
          updated_at: 3,
          pending_goals: [],
          open_threads: [],
          watches: [],
          recent_decisions: [],
        },
      },
      { running_tick_id: "tick-a" },
    );

    const wm = readWorkingMemory(db);
    expect(wm.pending_goals).toEqual([]);
  });

  it("preserves concurrent appended pending goals while flushing old snapshot goals", () => {
    const db = new Database(":memory:");
    seed(db);
    const baseRead: WorkingMemory = {
      version: 1,
      updated_at: 2,
      pending_goals: [{ kind: "user_goal", text: "stale", created_at: 0 }],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    };
    db.query("UPDATE long_lived_agents SET working_memory_json = ? WHERE id='a'").run(
      JSON.stringify(baseRead),
    );

    const concurrentGoal = { kind: "user_goal" as const, text: "fresh", created_at: 1500 };
    const withConcurrent: WorkingMemory = {
      ...baseRead,
      updated_at: 4,
      pending_goals: [baseRead.pending_goals[0]!, concurrentGoal],
    };
    db.query("UPDATE long_lived_agents SET working_memory_json = ? WHERE id='a'").run(
      JSON.stringify(withConcurrent),
    );

    updateLongLivedAgentState(
      db,
      "a",
      {
        working_memory: {
          version: 1,
          updated_at: 5,
          pending_goals: [],
          open_threads: [],
          watches: [],
          recent_decisions: [],
        },
      },
      { running_tick_id: "tick-a" },
    );

    const workingMemory = readWorkingMemory(db);
    expect(workingMemory.pending_goals).toEqual([concurrentGoal]);
  });

  it("does not lose updates when interleaved with concurrent post-tick goal writes", () => {
    const db = new Database(":memory:");
    seed(db);

    const goalA = { kind: "user_goal" as const, text: "approved-A", created_at: 100 };
    db.query("UPDATE long_lived_agents SET working_memory_json = ? WHERE id='a'").run(
      JSON.stringify({
        version: 1,
        updated_at: 100,
        pending_goals: [goalA],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      } satisfies WorkingMemory),
    );

    updateLongLivedAgentState(
      db,
      "a",
      {
        working_memory: {
          version: 1,
          updated_at: 150,
          pending_goals: [],
          open_threads: [{ id: "o1", topic: "t1", opened_at: 1, notes: "" }],
          watches: [],
          recent_decisions: [],
        },
      },
      { running_tick_id: "tick-a" },
    );

    let wm = readWorkingMemory(db);
    expect(wm.pending_goals).toEqual([goalA]);
    expect(wm.open_threads).toHaveLength(1);

    const goalB = { kind: "user_goal" as const, text: "approved-B", created_at: 200 };
    wm.pending_goals.push(goalB);
    db.query("UPDATE long_lived_agents SET working_memory_json = ? WHERE id='a'").run(
      JSON.stringify(wm),
    );

    updateLongLivedAgentState(
      db,
      "a",
      {
        working_memory: {
          version: 1,
          updated_at: 250,
          pending_goals: [],
          open_threads: [
            { id: "o1", topic: "t1", opened_at: 1, notes: "" },
            { id: "o2", topic: "t2", opened_at: 2, notes: "" },
          ],
          watches: [],
          recent_decisions: [],
        },
      },
      { running_tick_id: "tick-a" },
    );

    wm = readWorkingMemory(db);
    expect(wm.pending_goals).toEqual([goalA, goalB]);
    expect(wm.open_threads).toHaveLength(2);
  });

  it("performs the read-modify-write inside a single transaction", () => {
    const db = new Database(":memory:");
    seed(db);

    db.query("UPDATE long_lived_agents SET working_memory_json = ? WHERE id='a'").run(
      JSON.stringify({
        version: 1,
        updated_at: 50,
        pending_goals: [{ kind: "user_goal", text: "post-tick", created_at: 100 }],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      } satisfies WorkingMemory),
    );

    const observed: { sql: string; inTx: boolean }[] = [];
    const originalQuery = db.query.bind(db);
    type DbQuery = typeof db.query;
    type PreparedStatement = ReturnType<DbQuery>;
    type StatementMethod = (...args: unknown[]) => unknown;
    const spyQuery = ((sql: string): PreparedStatement => {
      const stmt = originalQuery(sql);
      return new Proxy(stmt, {
        get(target, prop): unknown {
          const value: unknown = Reflect.get(target, prop);
          if (typeof value === "function" && (prop === "get" || prop === "all" || prop === "run")) {
            return (...args: unknown[]): unknown => {
              observed.push({ sql, inTx: db.inTransaction });
              return (value as StatementMethod).apply(target, args);
            };
          }
          return value;
        },
      });
    }) as DbQuery;
    db.query = spyQuery;

    updateLongLivedAgentState(
      db,
      "a",
      {
        working_memory: {
          version: 1,
          updated_at: 200,
          pending_goals: [],
          open_threads: [],
          watches: [],
          recent_decisions: [],
        },
        intent_summary: "intent",
      },
      { running_tick_id: "tick-a" },
    );

    const agentTouches = observed.filter((entry) => entry.sql.includes("long_lived_agents"));
    expect(agentTouches.length).toBeGreaterThanOrEqual(2);
    expect(agentTouches.every((entry) => entry.inTx)).toBe(true);
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
