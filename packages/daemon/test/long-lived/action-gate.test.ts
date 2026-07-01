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

async function queueAndApproveIntegrationInstall(
  gate: ActionGate,
  db: Database,
  args: unknown,
): Promise<string> {
  const queued = await gate.handleCall({
    agent_id: "home",
    tick_id: "t1",
    tool: "ha:integration.install",
    args,
  });
  const pendingActionId = expectQueued(queued).pending_action_id;
  db.query(
    "UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=200 WHERE id=?",
  ).run(pendingActionId);
  return pendingActionId;
}

async function queueAndApproveAutomationSet(
  gate: ActionGate,
  db: Database,
  args: unknown,
): Promise<string> {
  db.query("UPDATE long_lived_agents SET approval_required_globs_json=? WHERE id='home'").run(
    JSON.stringify(["ha:automation.*"]),
  );
  const queued = await gate.handleCall({
    agent_id: "home",
    tick_id: "t1",
    tool: "ha:automation.set",
    args,
  });
  const pendingActionId = expectQueued(queued).pending_action_id;
  db.query(
    "UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=200 WHERE id=?",
  ).run(pendingActionId);
  return pendingActionId;
}

function insertTick(db: Database, id: string, startedAt = 200): void {
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES (?, 'home', 'injected_goal', ?)",
  ).run(id, startedAt);
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

  it("rejects with agent_config_corrupt when mcp_allowlist_json is unparseable (fail-closed)", async () => {
    const db = setup();
    db.query("UPDATE long_lived_agents SET mcp_allowlist_json='not-json' WHERE id='home'").run();
    const warn = mock(() => undefined);
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("snap1")),
      now: () => 100,
      log: { warn },
    });

    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:light.toggle",
      args: { entity_id: "light.kitchen" },
    });

    expect(expectRejected(result).error).toBe("agent_config_corrupt");
    expect(exec).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    const audit = expectRow(
      db
        .query<
          AuditRow,
          []
        >("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
        .get(),
    );
    expect(audit.decision).toBe("gate_failed");
    expect(audit.reason).toContain("agent_config_corrupt");
  });

  it("rejects with agent_config_corrupt when approval_required_globs_json is unparseable (fail-closed, no tier-3 downgrade)", async () => {
    const db = setup();
    db.query(
      "UPDATE long_lived_agents SET approval_required_globs_json='not-json' WHERE id='home'",
    ).run();
    const warn = mock(() => undefined);
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("snap1")),
      now: () => 100,
      log: { warn },
    });

    // ha:integration.install is tier-3 by baseline; with unparseable globs we
    // must reject (NOT auto-execute as tier-1) — this is the regression the
    // permissive [] fallback was masking.
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
    });
    expect(expectRejected(result).error).toBe("agent_config_corrupt");
    expect(exec).not.toHaveBeenCalled();
    const audit = expectRow(
      db
        .query<
          AuditRow,
          []
        >("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
        .get(),
    );
    expect(audit.decision).toBe("gate_failed");
    expect(audit.reason).toContain("agent_config_corrupt");
  });

  it("cooldown_overrides_json unparseable defaults safely to {}", async () => {
    const db = setup();
    db.query(
      "UPDATE long_lived_agents SET cooldown_overrides_json='not-json' WHERE id='home'",
    ).run();
    const gate = createActionGate({
      db,
      executeTool: mock(executeOk),
      takeSnapshot: mock(() => snapshot("snap1")),
      now: () => 100,
    });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
    });
    expect(result.kind).toBe("executed");
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

  it("fail-closed: pending_action_id for a different agent does NOT downgrade tier-3", async () => {
    const db = setup();
    // Register a second agent so the FK constraint on agent_id resolves; the
    // gate request will still run against 'home' below.
    reconcileLongLivedAgents(db, [{ ...longLivedAgentConfig(), name: "other" } as AgentConfig], {
      now: 1,
    });
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
      "UPDATE long_lived_pending_actions SET agent_id='other', status='approved', decided_by='user', decided_at=200 WHERE id=?",
    ).run(paId);
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t2', 'home', 'injected_goal', 200)",
    ).run();
    // home is the active agent; pending row is owned by 'not-home' → no downgrade
    const r2 = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });
    expect(r2.kind).toBe("queued");
    expect(exec).not.toHaveBeenCalled();
  });

  it("fail-closed: pending_action_id with status=pending does NOT downgrade tier-3", async () => {
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
    // Status still 'pending' — replay must be rejected.
    const r2 = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });
    expect(r2.kind).toBe("queued");
    expect(exec).not.toHaveBeenCalled();
  });

  it("fail-closed: already-executed pending_action_id is rejected and cannot replay", async () => {
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
      "UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=200, executed_in_tick_id='t-prior' WHERE id=?",
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
    expect(expectRejected(r2).error).toBe("already_executing");
    expect(exec).not.toHaveBeenCalled();
  });

  it("fail-closed: unknown pending_action_id cannot replay", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const r2 = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: "no-such-action-id",
    });
    expect(r2.kind).toBe("queued");
    expect(exec).not.toHaveBeenCalled();
  });

  it("tier 2 reserves the cooldown BEFORE executeTool (in-flight reservation)", async () => {
    const db = setup();
    let toolCalls = 0;
    const exec = mock(async (): Promise<{ ok: true }> => {
      toolCalls += 1;
      // While the first call is mid-flight, dispatch a second call. The
      // cooldown must be reserved already, so the second call rejects.
      const second = await gate.handleCall({
        agent_id: "home",
        tick_id: "t1",
        tool: "ha:automation.set",
        args: { entity_id: "automation.x" },
      });
      expect(expectRejected(second).error).toBe("cooldown_active");
      return { ok: true };
    });
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const first = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
    });
    expect(first.kind).toBe("executed");
    expect(toolCalls).toBe(1);
  });

  it("tier 2 clears the cooldown reservation when executeTool fails", async () => {
    const db = setup();
    const failingExec = mock(() => Promise.reject(new Error("tool blew up")));
    const gate = createActionGate({
      db,
      executeTool: failingExec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
    });
    expect(expectRejected(result).error).toBe("tool_failed");
    // Reservation must be cleared so the slot is not burned by the failed call.
    const cooldown = db
      .query<CooldownRow, []>("SELECT until_at FROM long_lived_cooldowns WHERE agent_id='home'")
      .get();
    expect(cooldown).toBeNull();
  });

  it("tier 2 clears the cooldown reservation when takeSnapshot fails", async () => {
    const db = setup();
    const gate = createActionGate({
      db,
      executeTool: mock(executeOk),
      takeSnapshot: mock(() => Promise.reject(new Error("snap blew up"))),
      now: () => 100,
    });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
    });
    expect(expectRejected(result).error).toBe("snapshot_failed");
    const cooldown = db
      .query<CooldownRow, []>("SELECT until_at FROM long_lived_cooldowns WHERE agent_id='home'")
      .get();
    expect(cooldown).toBeNull();
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

  it("fail-closed: approved replay with different args re-queues and does NOT execute", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const paId = await queueAndApproveIntegrationInstall(gate, db, { domain: "mqtt" });
    insertTick(db, "t2");

    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: { domain: "matter" },
      pending_action_id: paId,
    });

    expect(result.kind).toBe("queued");
    expect(exec).not.toHaveBeenCalled();
  });

  it("fail-closed: approved replay with different tool re-queues and does NOT execute", async () => {
    const db = setup();
    db.query("UPDATE long_lived_agents SET mcp_allowlist_json=? WHERE id='home'").run(
      JSON.stringify(["ha:light.*", "ha:automation.set", "ha:integration.*"]),
    );
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const paId = await queueAndApproveIntegrationInstall(gate, db, { domain: "mqtt" });
    insertTick(db, "t2");

    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.remove",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });

    expect(result.kind).toBe("queued");
    expect(exec).not.toHaveBeenCalled();
  });

  it("tier-1 call carrying an unrelated approved pending_action_id does NOT poison that row's executed_in_tick_id [Race-B]", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });

    const approvedPaId = await queueAndApproveIntegrationInstall(gate, db, { domain: "mqtt" });

    insertTick(db, "t2");
    const tier1 = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:light.toggle",
      args: { entity_id: "light.kitchen" },
      pending_action_id: approvedPaId,
    });
    expect(tier1.kind).toBe("executed");

    const rowAfterTier1 = expectRow(
      db
        .query<
          ExecutedPendingActionRow,
          [string]
        >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
        .get(approvedPaId),
    );
    expect(rowAfterTier1.executed_in_tick_id).toBeNull();

    insertTick(db, "t3", 201);
    const replay = await gate.handleCall({
      agent_id: "home",
      tick_id: "t3",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: approvedPaId,
    });
    expect(replay.kind).toBe("executed");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("approved replay claims the pending action so only one concurrent caller executes", async () => {
    const db = setup();
    let resolveExec: ((value: { ok: true }) => void) | undefined;
    const exec = mock(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveExec = resolve;
        }),
    );
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const paId = await queueAndApproveIntegrationInstall(gate, db, { domain: "mqtt" });
    insertTick(db, "t2");
    insertTick(db, "t3", 201);

    const first = gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });
    const second = gate.handleCall({
      agent_id: "home",
      tick_id: "t3",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    resolveExec?.({ ok: true });
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.kind === "executed")).toHaveLength(1);
    const rejected = results.find((result) => result.kind === "rejected");
    expect(rejected?.kind).toBe("rejected");
    if (rejected?.kind === "rejected") expect(rejected.error).toBe("already_executing");
  });

  it("approved tier-2 replay consumes its pending action so a later replay cannot execute again", async () => {
    const db = setup();
    let now = 100;
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => now,
    });
    const paId = await queueAndApproveAutomationSet(gate, db, { entity_id: "automation.x" });
    insertTick(db, "t2");

    const first = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
      pending_action_id: paId,
    });
    expect(first.kind).toBe("executed");
    expect(exec).toHaveBeenCalledTimes(1);

    now = 700_000;
    insertTick(db, "t3", 700_000);
    const second = await gate.handleCall({
      agent_id: "home",
      tick_id: "t3",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
      pending_action_id: paId,
    });

    expect(expectRejected(second).error).toBe("already_executing");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("approved replay rolls back its claim when executeTool fails so a later valid replay succeeds", async () => {
    const db = setup();
    let claimDuringExecution: string | null | undefined;
    const exec = mock()
      .mockImplementationOnce(() => {
        claimDuringExecution = expectRow(
          db
            .query<
              ExecutedPendingActionRow,
              [string]
            >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
            .get(paId),
        ).executed_in_tick_id;
        return Promise.reject(new Error("tool blew up"));
      })
      .mockImplementationOnce(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const paId = await queueAndApproveIntegrationInstall(gate, db, { domain: "mqtt" });
    insertTick(db, "t2");
    insertTick(db, "t3", 201);

    const failed = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });
    expect(expectRejected(failed).error).toBe("tool_failed");
    expect(claimDuringExecution).toBe("t2");
    const afterFailure = expectRow(
      db
        .query<
          ExecutedPendingActionRow,
          [string]
        >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
        .get(paId),
    );
    expect(afterFailure.executed_in_tick_id).toBeNull();

    const retried = await gate.handleCall({
      agent_id: "home",
      tick_id: "t3",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });
    expect(retried.kind).toBe("executed");
    expect(exec).toHaveBeenCalledTimes(2);
    const afterRetry = expectRow(
      db
        .query<
          ExecutedPendingActionRow,
          [string]
        >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
        .get(paId),
    );
    expect(afterRetry.executed_in_tick_id).toBe("t3");
  });

  it("approved tier-2 replay rolls back its claim and cooldown when executeTool fails", async () => {
    const db = setup();
    let claimDuringExecution: string | null | undefined;
    const exec = mock()
      .mockImplementationOnce(() => {
        claimDuringExecution = expectRow(
          db
            .query<
              ExecutedPendingActionRow,
              [string]
            >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
            .get(paId),
        ).executed_in_tick_id;
        return Promise.reject(new Error("tool blew up"));
      })
      .mockImplementationOnce(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const paId = await queueAndApproveAutomationSet(gate, db, { entity_id: "automation.x" });
    insertTick(db, "t2");
    insertTick(db, "t3", 201);

    const failed = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
      pending_action_id: paId,
    });
    expect(expectRejected(failed).error).toBe("tool_failed");
    expect(claimDuringExecution).toBe("t2");
    const afterFailure = expectRow(
      db
        .query<
          ExecutedPendingActionRow,
          [string]
        >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
        .get(paId),
    );
    expect(afterFailure.executed_in_tick_id).toBeNull();
    const cooldown = db
      .query<CooldownRow, []>("SELECT until_at FROM long_lived_cooldowns WHERE agent_id='home'")
      .get();
    expect(cooldown).toBeNull();

    const retried = await gate.handleCall({
      agent_id: "home",
      tick_id: "t3",
      tool: "ha:automation.set",
      args: { entity_id: "automation.x" },
      pending_action_id: paId,
    });
    expect(retried.kind).toBe("executed");
    expect(exec).toHaveBeenCalledTimes(2);
    const afterRetry = expectRow(
      db
        .query<
          ExecutedPendingActionRow,
          [string]
        >("SELECT executed_in_tick_id FROM long_lived_pending_actions WHERE id=?")
        .get(paId),
    );
    expect(afterRetry.executed_in_tick_id).toBe("t3");
  });

  it("approved replay authorizes a stored action_kind with different casing", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const paId = await queueAndApproveIntegrationInstall(gate, db, { domain: "mqtt" });
    db.query(
      "UPDATE long_lived_pending_actions SET action_kind='HA:Integration.Install' WHERE id=?",
    ).run(paId);
    insertTick(db, "t2");

    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: { domain: "mqtt" },
      pending_action_id: paId,
    });

    expect(result.kind).toBe("executed");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("approved replay accepts structurally equal args regardless of key order and accepts arg-less {}", async () => {
    const db = setup();
    const exec = mock(executeOk);
    const gate = createActionGate({
      db,
      executeTool: exec,
      takeSnapshot: mock(() => snapshot("s")),
      now: () => 100,
    });
    const reorderedPaId = await queueAndApproveIntegrationInstall(gate, db, {
      domain: "mqtt",
      config: { host: "broker", port: 1883 },
    });
    insertTick(db, "t2");

    const reordered = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: { config: { port: 1883, host: "broker" }, domain: "mqtt" },
      pending_action_id: reorderedPaId,
    });
    expect(reordered.kind).toBe("executed");

    const arglessQueued = await gate.handleCall({
      agent_id: "home",
      tick_id: "t2",
      tool: "ha:integration.install",
      args: {},
    });
    const arglessPaId = expectQueued(arglessQueued).pending_action_id;
    db.query(
      "UPDATE long_lived_pending_actions SET status='approved', decided_by='user', decided_at=300 WHERE id=?",
    ).run(arglessPaId);
    insertTick(db, "t3", 300);

    const argless = await gate.handleCall({
      agent_id: "home",
      tick_id: "t3",
      tool: "ha:integration.install",
      args: {},
      pending_action_id: arglessPaId,
    });
    expect(argless.kind).toBe("executed");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
