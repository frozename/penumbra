import type { AgentConfig } from "@penumbra/agentchat/config";

import { type ActionGate, createActionGate } from "@penumbra/daemon/long-lived/action-gate";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";

import { applySchema } from "../../../core/src/db/schema.js";
import { loadSqliteVec } from "../../../core/src/db/sqlite-vec.js";

type ActionGateResult = Awaited<ReturnType<ActionGate["handleCall"]>>;
type AuditRow = { decision: string; reason: string };
type CooldownRow = { until_at: number };
type PendingActionRow = { action_kind: string; status: string };
type ExecutedPendingActionRow = { executed_in_tick_id: string | null };

function longLivedAgentConfig(): AgentConfig {
  return {
    name: "home",
    adapter: "test",
    options: {},
    roles: [],
    auto_approve_to: [],
    pricing_mode: "api",
    long_lived: true,
    long_lived_config: {
      schedule_cron: "*/15 * * * *",
      subscriptions: [],
      mcp_allowlist: [
        "ha:light.*",
        "ha:automation.set",
        "ha:integration.install",
        "ha:snapshot.create",
        "penumbra:long_lived_self_state_set",
      ],
      hosted_mcp_servers: [],
      require_snapshot: false,
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      action_tiers: { approval_required_globs: ["ha:integration.*"], cooldown_overrides: {} },
      standing_brief: "x",
    },
  };
}

function setup(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [longLivedAgentConfig()], { now: 1 });
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'home', 'manual', 1)",
  ).run();
  return db;
}

function executeOk(): Promise<{ ok: true }> {
  return Promise.resolve({ ok: true });
}

function snapshot(id = "snap"): Promise<string> {
  return Promise.resolve(id);
}

function expectRow<T>(row: T | null): T {
  expect(row).not.toBeNull();
  if (row === null) throw new Error("expected database row");
  return row;
}

function expectRejected(result: ActionGateResult): Extract<ActionGateResult, { kind: "rejected" }> {
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") throw new Error("expected rejected action");
  return result;
}

function expectQueued(result: ActionGateResult): Extract<ActionGateResult, { kind: "queued" }> {
  expect(result.kind).toBe("queued");
  if (result.kind !== "queued") throw new Error("expected queued action");
  return result;
}

describe("action gate", () => {
  it("rejects tool not in allowlist", async () => {
    const db = setup();
    const gate = createActionGate({
      db,
      executeTool: mock(executeOk),
      takeSnapshot: mock(() => snapshot("snap1")),
      now: () => 100,
    });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.uninstall",
      args: { domain: "mqtt" },
    });
    expect(expectRejected(result).error).toBe("not_in_allowlist");
    const audit = expectRow(
      db
        .query<
          AuditRow,
          []
        >("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
        .get(),
    );
    expect(audit.decision).toBe("gate_failed");
    expect(audit.reason).toBe("not_in_allowlist");
  });

  it("falls back safely when agent config JSON is malformed", async () => {
    const db = setup();
    db.query(
      "UPDATE long_lived_agents SET mcp_allowlist_json='not-json', approval_required_globs_json='not-json', cooldown_overrides_json='not-json' WHERE id='home'",
    ).run();
    const warn = mock(() => undefined);
    const gate = createActionGate({
      db,
      executeTool: mock(executeOk),
      takeSnapshot: mock(() => snapshot("snap1")),
      now: () => 100,
      log: { warn },
    });

    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.uninstall",
      args: { domain: "mqtt" },
    });

    expect(expectRejected(result).error).toBe("not_in_allowlist");
    expect(warn).toHaveBeenCalled();
  });

  it("tier 1 executes immediately and audits success", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(snapshot),
      now: () => 100,
    });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:light.toggle",
      args: { entity_id: "light.kitchen" },
    });
    expect(result.kind).toBe("executed");
    expect(exec).toHaveBeenCalledTimes(1);
    const audit = expectRow(
      db
        .query<
          AuditRow,
          []
        >("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
        .get(),
    );
    expect(audit.decision).toBe("executed");
    expect(audit.reason).toBe("tier_1");
  });

  it("tier 1 forwards _meta to executeTool", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(snapshot),
      now: () => 100,
    });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:light.toggle",
      args: { entity_id: "light.kitchen" },
      _meta: { origin: "claude-code" },
    });
    expect(result.kind).toBe("executed");
    expect(exec).toHaveBeenCalledWith(
      "ha:light.toggle",
      { entity_id: "light.kitchen" },
      { origin: "claude-code" },
    );
  });

  it("tier 2 takes a snapshot, executes, sets cooldown", async () => {
    const db = setup();
    const snap = mock(() => snapshot("snap-id-1"));
    const gate = createActionGate({
      db,
      executeTool: mock(executeOk),
      takeSnapshot: snap,
      now: () => 100,
    });
    const r = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
    });
    expect(r.kind).toBe("executed");
    expect(snap).toHaveBeenCalledTimes(1);
    const cooldown = expectRow(
      db
        .query<CooldownRow, []>("SELECT until_at FROM long_lived_cooldowns WHERE agent_id='home'")
        .get(),
    );
    expect(cooldown.until_at).toBe(100 + 600_000);
    const audit = expectRow(
      db
        .query<
          AuditRow,
          []
        >("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
        .get(),
    );
    expect(audit.decision).toBe("executed");
    expect(audit.reason).toContain("snapshot:snap-id-1");
  });

  it("tier 2 forwards _meta to executeTool", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const snap = mock(() => snapshot("snap-id-1"));
    const gate = createActionGate({ db, executeTool: exec, takeSnapshot: snap, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
      _meta: { origin: "claude-code", trace: "trace-1" },
    });
    expect(result.kind).toBe("executed");
    expect(exec).toHaveBeenCalledWith(
      "ha:automation.set",
      { entity_id: "automation.x" },
      { origin: "claude-code", trace: "trace-1" },
    );
  });

  it("tier 2 second call within cooldown is rejected", async () => {
    const db = setup();
    const gate = createActionGate({
      db,
      executeTool: mock(executeOk),
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
    });
    const second = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
    });
    expect(expectRejected(second).error).toBe("cooldown_active");
  });

  it("tier 3 files a pending action and does NOT execute", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const r = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
    });
    expect(r.kind).toBe("queued");
    expect(exec).not.toHaveBeenCalled();
    const pa = expectRow(
      db
        .query<
          PendingActionRow,
          []
        >("SELECT action_kind, status FROM long_lived_pending_actions WHERE tick_id='t1'")
        .get(),
    );
    expect(pa.action_kind).toBe("ha:integration.install");
    expect(pa.status).toBe("pending");
  });

  it("Tier 3 queued action persists _meta in meta_json; approval forwards it intact", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const queued = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      _meta: { origin: "claude-code", trace: "t-3" },
    });
    const pendingActionId = expectQueued(queued).pending_action_id;

    const row = db
      .query<
        { meta_json: string | null },
        [string]
      >("SELECT meta_json FROM long_lived_pending_actions WHERE id=?")
      .get(pendingActionId);
    expect(row?.meta_json).toBe(JSON.stringify({ origin: "claude-code", trace: "t-3" }));

    db.query(
      "UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=200 WHERE id=?",
    ).run(pendingActionId);
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t3', 'home', 'injected_goal', 200)",
    ).run();
    const executed = await gate.handleCall({
      agent_id: "home",
      tick_id: "t3",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: pendingActionId,
    });
    expect(executed.kind).toBe("executed");
    expect(exec).toHaveBeenCalledWith(
      "ha:integration.install",
      { domain: "mqtt" },
      { origin: "claude-code", trace: "t-3" },
    );
  });

  it("approved-action re-entry bypasses tier 3 queue", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const r1 = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
    });
    const paId = expectQueued(r1).pending_action_id;
    db.query(
      "UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=200 WHERE id=?",
    ).run(paId);
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t2', 'home', 'injected_goal', 200)",
    ).run();
    const r2 = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });
    expect(r2.kind).toBe("executed");
    const pa = expectRow(
      db
        .query<
          ExecutedPendingActionRow,
          [string]
        >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
        .get(paId),
    );
    expect(pa.executed_in_tick_id).toBe("t2");
  });
});
