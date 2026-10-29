import { type AgentConfig, AgentConfigSchema } from "@penumbra/agentchat/config/types";
import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { handleLongLivedApproveAction } from "@penumbra/mcp/tools/long-lived-approve-action";
import { handleLongLivedResume } from "@penumbra/mcp/tools/long-lived-resume";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock } from "bun:test";

import { createMcpEventBus } from "@src/events/mcp-event-bus.js";
import { createActionGate } from "@src/long-lived/action-gate.js";
import type { McpPool } from "@src/long-lived/mcp-pool.js";
import { stampPrompt } from "@src/long-lived/prompt-stamper.js";
import { reconcileLongLivedAgents } from "@src/long-lived/reconciler.js";
import { createTickGate } from "@src/long-lived/tick-gate.js";
import { createLongLivedReactor } from "@src/reactors/long-lived-reactor.js";
import { chainStartInternal } from "@src/routes/chains.js";
import { longLivedResumeRoute } from "@src/routes/long-lived.js";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function makeDb(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

function configuredAgent(name: string): AgentConfig {
  return AgentConfigSchema.parse({
    name,
    adapter: "test",
    long_lived: true,
    long_lived_config: {
      schedule_cron: "*/15 * * * *",
      subscriptions: [{ server: "ha", event: "state_changed" }],
      hosted_mcp_servers: [{ name: "ha", command: "unused-ha-server" }],
      mcp_allowlist: ["ha:light.toggle"],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      standing_brief: "legacy operator",
    },
  });
}

function seedLegacyHome(db: Database): void {
  db.query(
    `INSERT INTO long_lived_agents
      (id, display_name, working_memory_json, standing_brief, mcp_allowlist_json, created_at, updated_at)
      VALUES ('home-mgmt', 'Home management', '{}', 'legacy', '["ha:light.toggle"]', 1, 1)`,
  ).run();
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('legacy-tick', 'home-mgmt', 'cron', 1)",
  ).run();
  db.query(
    `INSERT INTO long_lived_pending_actions
      (id, agent_id, tick_id, action_kind, action_target, payload_json, expires_at, created_at)
      VALUES ('legacy-action', 'home-mgmt', 'legacy-tick', 'ha:light.toggle', 'light.kitchen', '{}', 9999, 1)`,
  ).run();
}

function makeServices(db: Database): Services {
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
}

describe("home-mgmt retirement", () => {
  it("ignores obsolete YAML while registering both task refiners", () => {
    const db = makeDb();
    const result = reconcileLongLivedAgents(
      db,
      [
        configuredAgent("home-mgmt"),
        configuredAgent("task-refiner-primary"),
        configuredAgent("task-refiner-escalation"),
      ],
      { now: 100 },
    );
    expect(result.inserted).toEqual(["task-refiner-primary", "task-refiner-escalation"]);
    expect(db.query("SELECT id FROM long_lived_agents WHERE id='home-mgmt'").get()).toBeNull();
  });

  it("retires a legacy operator without reactivation or loss of its history", () => {
    const db = makeDb();
    seedLegacyHome(db);
    expect(
      reconcileLongLivedAgents(db, [configuredAgent("home-mgmt")], { now: 100 }).retired,
    ).toEqual(["home-mgmt"]);
    reconcileLongLivedAgents(db, [configuredAgent("home-mgmt")], { now: 200 });
    expect(
      db
        .query(
          "SELECT status, retired_at, working_memory_json FROM long_lived_agents WHERE id='home-mgmt'",
        )
        .get(),
    ).toEqual({ status: "retired", retired_at: 100, working_memory_json: "{}" });
    expect(db.query("SELECT id FROM long_lived_ticks WHERE id='legacy-tick'").get()).not.toBeNull();
    expect(
      db.query("SELECT status FROM long_lived_pending_actions WHERE id='legacy-action'").get(),
    ).toEqual({ status: "pending" });
  });

  it("does not register a cron, event subscription, or hosted MCP server for home-mgmt", async () => {
    const db = makeDb();
    seedLegacyHome(db);
    const bus = createMcpEventBus();
    const spawn = mock(() => Promise.resolve({ chain_id: "unused" }));
    const ensureRunning = mock(() => Promise.resolve());
    const acquire = mock(() => undefined);
    const pool: McpPool = {
      ensureRunning,
      acquire,
      release: mock(() => undefined),
      shutdown: () => Promise.resolve(),
      callTool: () => Promise.resolve({}),
      listTools: () => Promise.resolve([]),
      getFederationHealth: () => ({ registered: [], skipped: [] }),
    };
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      now: () => 100,
      isChainActive: () => false,
      mcpPool: pool,
      loadAgentchatYaml: () => Promise.resolve({ agents: [configuredAgent("home-mgmt")] }),
    });
    try {
      await reactor.reload();
      await reactor.reload();
      expect(reactor._cronList()).not.toContain("home-mgmt");
      bus.publish({ server: "ha", event: "state_changed", payload: {}, published_at: 100 });
      expect(reactor.manualTick("home-mgmt").outcome).toBe("skipped_status");
      expect(spawn).not.toHaveBeenCalled();
      expect(ensureRunning).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await reactor.shutdown();
    }
  });

  it("blocks ticks even before legacy state has been reconciled", () => {
    const db = makeDb();
    seedLegacyHome(db);
    db.query("UPDATE long_lived_ticks SET completed_at=2 WHERE id='legacy-tick'").run();
    const spawn = mock(() => ({ chain_id: "unused", tick_id: "unused" }));
    const gate = createTickGate({ db, spawn, isChainActive: () => false, now: () => 100 });
    for (const trigger_kind of ["cron", "event", "manual", "injected_goal"] as const) {
      expect(gate.attempt({ agent_id: "home-mgmt", trigger_kind }).outcome).toBe("skipped_status");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["active", "paused", "degraded", "retired"])(
    "rejects resume from legacy %s state",
    (status) => {
      const db = makeDb();
      seedLegacyHome(db);
      db.query("UPDATE long_lived_agents SET status=? WHERE id='home-mgmt'").run(status);
      expect(() => handleLongLivedResume(db, { id: "home-mgmt" })).toThrow("agent_retired");
      expect(
        longLivedResumeRoute(
          new Request("http://localhost/long-lived/home-mgmt/resume", { method: "POST" }),
          "home-mgmt",
          makeServices(db),
        ).status,
      ).toBe(410);
    },
  );

  it("rejects new actions and approved replays from a legacy running tick", async () => {
    const db = makeDb();
    seedLegacyHome(db);
    const executeTool = mock(() => Promise.resolve({}));
    const takeSnapshot = mock(() => Promise.resolve("unused"));
    const gate = createActionGate({ db, executeTool, takeSnapshot, now: () => 100 });
    const request = {
      agent_id: "home-mgmt",
      tick_id: "legacy-tick",
      tool: "ha:light.toggle",
      args: {},
    };
    expect(await gate.handleCall(request)).toEqual({ kind: "rejected", error: "agent_retired" });
    db.query(
      "UPDATE long_lived_pending_actions SET status='approved' WHERE id='legacy-action'",
    ).run();
    expect(await gate.handleCall({ ...request, pending_action_id: "legacy-action" })).toEqual({
      kind: "rejected",
      error: "agent_retired",
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(takeSnapshot).not.toHaveBeenCalled();
  });

  it("rejects pending approvals without modifying state or emitting a goal", () => {
    const db = makeDb();
    seedLegacyHome(db);
    const emit = mock(() => undefined);
    expect(() =>
      handleLongLivedApproveAction(db, { emit, now: () => 100 }, { action_id: "legacy-action" }),
    ).toThrow("agent_retired");
    expect(emit).not.toHaveBeenCalled();
    expect(
      db.query("SELECT status FROM long_lived_pending_actions WHERE id='legacy-action'").get(),
    ).toEqual({ status: "pending" });
  });

  it("rejects direct dispatch and sub-dispatches carrying the retired identity", async () => {
    const db = makeDb();
    seedLegacyHome(db);
    const services = makeServices(db);
    for (const input of [
      { initial_agent: "home-mgmt" },
      {
        initial_agent: "task-refiner-primary",
        dispatch_kind: "long_lived_tick" as const,
        long_lived_agent_id: "home-mgmt",
        long_lived_tick_id: "legacy-tick",
      },
    ]) {
      const response = await chainStartInternal(
        {
          ...input,
          message: "legacy work",
          project_id: "penumbra",
          max_hops: 1,
          trust_mode: "all",
          use_worktree: false,
        },
        services,
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: { code: "agent_retired" } });
    }
  });

  it("uses a domain-neutral action policy in task-refiner prompts", () => {
    const prompt = stampPrompt({
      agent: {
        id: "task-refiner-primary",
        display_name: "Task refiner",
        standing_brief: "refine drafts",
        mcp_allowlist: ["penumbra:task_draft_list_pending"],
        working_memory: {
          version: 1,
          updated_at: 1,
          pending_goals: [],
          open_threads: [],
          watches: [],
          recent_decisions: [],
        },
        bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      },
      tick: { id: "refiner-tick", trigger_kind: "cron", trigger_payload: null, now_iso: "now" },
    });
    expect(prompt).not.toContain("HA snapshot");
    expect(prompt).not.toContain("Home Assistant");
    expect(prompt).toContain("queued for approval");
  });

  it("rejects a role that still routes to the retired operator", async () => {
    const db = makeDb();
    const services = makeServices(db);
    services.agentRegistry = ["home-mgmt"];
    services.agentRouting = {
      agents: [{ name: "home-mgmt", roles: ["executor"] }],
      default_roles: { executor: "home-mgmt" },
    };
    const response = await chainStartInternal(
      {
        initial_agent: "executor",
        message: "legacy work",
        project_id: "penumbra",
        max_hops: 1,
        trust_mode: "all",
        use_worktree: false,
      },
      services,
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: { code: "agent_retired", agent: "home-mgmt" },
    });
    expect(db.query("SELECT handoff_id FROM handoffs").all()).toEqual([]);
  });
});
