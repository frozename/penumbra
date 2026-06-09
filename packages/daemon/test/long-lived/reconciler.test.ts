import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import type { AgentConfig } from "@penumbra/agentchat/config";

function mkAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "home-mgmt",
    long_lived: true,
    long_lived_config: {
      schedule_cron: "*/15 * * * *",
      subscriptions: [{ server: "ha", event: "state_changed" }],
      mcp_allowlist: ["ha:state.*"],
      bounds: { wall_clock_ms: 180000, cost_cents: 50, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: "be helpful",
    },
    ...overrides,
  } as AgentConfig;
}

function setup() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

describe("reconcileLongLivedAgents", () => {
  it("inserts new agents and seeds working memory", () => {
    const db = setup();
    const result = reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    expect(result.inserted).toEqual(["home-mgmt"]);
    expect(result.updated).toEqual([]);
    expect(result.retired).toEqual([]);

    const row = db.query("SELECT * FROM long_lived_agents WHERE id='home-mgmt'").get() as any;
    expect(row.status).toBe("active");
    expect(row.created_at).toBe(1000);
    const wm = JSON.parse(row.working_memory_json);
    expect(wm.version).toBe(1);
    expect(wm.pending_goals).toEqual([]);
    expect(wm.open_threads).toEqual([]);
  });

  it("forces self-tools into the allowlist on insert", () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    const row = db
      .query("SELECT mcp_allowlist_json FROM long_lived_agents WHERE id='home-mgmt'")
      .get() as any;
    const al = JSON.parse(row.mcp_allowlist_json) as string[];
    expect(al).toContain("penumbra:long_lived_self_state_get");
    expect(al).toContain("penumbra:long_lived_self_state_set");
    expect(al).toContain("penumbra:long_lived_self_pending_actions");
  });

  it("updates schedule_cron on second run without clobbering working memory or status", () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    db.query(
      "UPDATE long_lived_agents SET status='degraded', consecutive_failures=3, working_memory_json=? WHERE id=?",
    ).run(
      JSON.stringify({
        version: 1,
        updated_at: 2000,
        pending_goals: [],
        open_threads: [{ id: "o1", topic: "t", opened_at: 1, notes: "" }],
        watches: [],
        recent_decisions: [],
      }),
      "home-mgmt",
    );

    const newer = mkAgent({
      long_lived_config: { ...mkAgent().long_lived_config!, schedule_cron: "*/30 * * * *" },
    });
    reconcileLongLivedAgents(db, [newer], { now: 3000 });
    const row = db.query("SELECT * FROM long_lived_agents WHERE id='home-mgmt'").get() as any;
    expect(row.status).toBe("degraded");
    expect(row.consecutive_failures).toBe(3);
    expect(row.schedule_cron).toBe("*/30 * * * *");
    const wm = JSON.parse(row.working_memory_json);
    expect(wm.open_threads).toHaveLength(1);
  });

  it("reactivates retired agents that remain in yaml", () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    db.query(
      "UPDATE long_lived_agents SET status='retired', consecutive_failures=5, degraded_reason='oops', retired_at=900, updated_at=900 WHERE id='home-mgmt'",
    ).run();

    const result = reconcileLongLivedAgents(db, [mkAgent()], { now: 2000 });
    expect(result.updated).toEqual(["home-mgmt"]);

    const row = db
      .query(
        "SELECT status, consecutive_failures, degraded_reason, retired_at FROM long_lived_agents WHERE id='home-mgmt'",
      )
      .get() as any;
    expect(row).toEqual({
      status: "active",
      consecutive_failures: 0,
      degraded_reason: null,
      retired_at: null,
    });
  });

  it("does not reactivate degraded or paused agents that remain in yaml", () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    db.query(
      "UPDATE long_lived_agents SET status='degraded', consecutive_failures=5, degraded_reason='oops', retired_at=NULL, updated_at=900 WHERE id='home-mgmt'",
    ).run();

    reconcileLongLivedAgents(db, [mkAgent()], { now: 2000 });
    let row = db
      .query(
        "SELECT status, consecutive_failures, degraded_reason, retired_at FROM long_lived_agents WHERE id='home-mgmt'",
      )
      .get() as any;
    expect(row).toEqual({
      status: "degraded",
      consecutive_failures: 5,
      degraded_reason: "oops",
      retired_at: null,
    });

    db.query(
      "UPDATE long_lived_agents SET status='paused', consecutive_failures=5, degraded_reason='oops', retired_at=NULL, updated_at=900 WHERE id='home-mgmt'",
    ).run();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 3000 });
    row = db
      .query(
        "SELECT status, consecutive_failures, degraded_reason, retired_at FROM long_lived_agents WHERE id='home-mgmt'",
      )
      .get() as any;
    expect(row).toEqual({
      status: "paused",
      consecutive_failures: 5,
      degraded_reason: "oops",
      retired_at: null,
    });
  });

  it("retires agents that disappear from yaml", () => {
    const db = setup();
    reconcileLongLivedAgents(db, [mkAgent()], { now: 1000 });
    const result = reconcileLongLivedAgents(db, [], { now: 2000 });
    expect(result.retired).toEqual(["home-mgmt"]);
    const row = db
      .query("SELECT status, retired_at FROM long_lived_agents WHERE id='home-mgmt'")
      .get() as any;
    expect(row.status).toBe("retired");
    expect(row.retired_at).toBe(2000);
  });

  it("ignores agents without long_lived: true", () => {
    const db = setup();
    const result = reconcileLongLivedAgents(
      db,
      [{ name: "coder", long_lived: false } as AgentConfig],
      { now: 1000 },
    );
    expect(result.inserted).toEqual([]);
  });
});
