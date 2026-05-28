import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "../../src/long-lived/reconciler.js";
import { buildActionGateCallbacks } from "../../src/long-lived/action-gate-callbacks.js";
import { createActionGate } from "../../src/long-lived/action-gate.js";

function setup() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

function makeLog() {
  return {
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function seedAgent(
  db: Database,
  allowlist: string[],
  approval_required_globs: string[] = [],
  opts: { snapshot_tool?: string | null; require_snapshot?: boolean } = {},
): void {
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "home",
        long_lived: true,
        long_lived_config: {
          schedule_cron: "*/15 * * * *",
          subscriptions: [],
          mcp_allowlist: allowlist,
          snapshot_tool: opts.snapshot_tool ?? null,
          require_snapshot: opts.require_snapshot ?? false,
          bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3,
          action_tiers: { approval_required_globs, cooldown_overrides: {} },
          standing_brief: "x",
        },
      } as any,
    ],
    { now: 1 },
  );
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'home', 'manual', 1)",
  ).run();
}

describe("action gate pool integration", () => {
  test("tier 1 executed", async () => {
    const db = setup();
    seedAgent(db, ["ha:ha_get_state"]);
    const callTool = mock(async () => ({ state: "on" }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:ha_get_state",
      args: {},
    });
    expect(result).toEqual({ kind: "executed", result: { state: "on" }, tier: 1 });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("ha", "ha_get_state", {});
  });

  test("tier 2 with snapshot taken", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set", "ha:ha_backup_create"], [], {
      snapshot_tool: "ha:ha_backup_create",
    });
    const callTool = mock(async (server: string, tool: string) => {
      if (server === "ha" && tool === "ha_backup_create") return { snapshot_id: "snap-123" };
      return { ok: true };
    });
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: {},
    });
    expect(result).toEqual({
      kind: "executed",
      result: { ok: true },
      tier: 2,
      snapshot_id: "snap-123",
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenNthCalledWith(1, "ha", "ha_backup_create", {});
    expect(callTool).toHaveBeenNthCalledWith(2, "ha", "automation.set", {});
  });

  test("tier 2 without snapshot tool in allowlist still executes and audits sentinel snapshot id", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set"], [], { snapshot_tool: "ha:ha_backup_create" });
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: {},
    });
    expect(result.kind).toBe("executed");
    expect((result as any).snapshot_id).toBe("snapshot_skipped_not_in_allowlist");
    expect(fakeLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ tier2_fail_open: true, reason: "snapshot_tool_not_in_allowlist" }),
      "action-gate-snapshot-skipped",
    );
    const audit = db
      .query("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
      .get() as any;
    expect(audit.decision).toBe("executed");
    expect(String(audit.reason)).toContain("snapshot:snapshot_skipped_not_in_allowlist");
  });

  test("tier 2 snapshot call throws", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set", "ha:ha_backup_create"], [], {
      snapshot_tool: "ha:ha_backup_create",
    });
    const callTool = mock(async (server: string, tool: string) => {
      if (server === "ha" && tool === "ha_backup_create") throw new Error("boom");
      return { ok: true };
    });
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: {},
    });
    expect(result).toEqual({ kind: "rejected", error: "snapshot_failed" });
    const audit = db
      .query("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
      .get() as any;
    expect(audit.decision).toBe("gate_failed");
    expect(String(audit.reason)).toContain("snapshot_failed: boom");
  });

  test("tier 3 queued", async () => {
    const db = setup();
    seedAgent(db, ["ha:ha_config_set_automation"], ["ha:ha_config_*"]);
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:ha_config_set_automation",
      args: {},
    });
    expect(result.kind).toBe("queued");
    expect(callTool).not.toHaveBeenCalled();
  });

  test("rejected not in allowlist", async () => {
    const db = setup();
    seedAgent(db, ["ha:ha_get_state"]);
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:not_in_allowlist",
      args: {},
    });
    expect(result).toEqual({ kind: "rejected", error: "not_in_allowlist" });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("mcpPool.callTool fails for executed path", async () => {
    const db = setup();
    seedAgent(db, ["ha:ha_get_state"]);
    const callTool = mock(async () => {
      throw new Error("tool broke");
    });
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:ha_get_state",
      args: {},
    });
    expect(result).toEqual({ kind: "rejected", error: "tool_failed" });
    const audit = db
      .query("SELECT decision, reason FROM long_lived_action_audit WHERE tick_id='t1'")
      .get() as any;
    expect(audit.decision).toBe("tool_failed");
    expect(String(audit.reason)).toContain("tool broke");
  });

  test("tier 2 snapshot honors string allowlist entries when malformed non-strings are present", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set"], [], { snapshot_tool: "ha:ha_backup_create" });
    db.query(
      "UPDATE long_lived_agents SET mcp_allowlist_json = '[1, \"ha:automation.set\", \"ha:ha_backup_create\", null]' WHERE id = 'home'",
    ).run();
    const callTool = mock(async (server: string, tool: string) => {
      if (server === "ha" && tool === "ha_backup_create")
        return { snapshot_id: "snap-malformed-allowlist" };
      return { ok: true };
    });
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: {},
    });
    expect(result).toEqual({
      kind: "executed",
      result: { ok: true },
      tier: 2,
      snapshot_id: "snap-malformed-allowlist",
    });
    expect(fakeLog.error).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  test("tier 2 with no snapshot_tool configured and require_snapshot=false executes with sentinel", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set"]);
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: {},
    });
    expect(result).toEqual({
      kind: "executed",
      result: { ok: true },
      tier: 2,
      snapshot_id: "snapshot_skipped_no_snapshot_tool_configured",
    });
    expect(fakeLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ tier2_fail_open: true, reason: "no_snapshot_tool_configured" }),
      "action-gate-snapshot-skipped",
    );
  });

  test("tier 2 with no snapshot_tool configured and require_snapshot=true rejected with snapshot_failed", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set"], [], { require_snapshot: true });
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: {},
    });
    expect(result).toEqual({ kind: "rejected", error: "snapshot_failed" });
  });

  test("tier 2 with snapshot_tool not in allowlist and require_snapshot=true rejected with snapshot_failed", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set"], [], {
      snapshot_tool: "ha:ha_backup_create",
      require_snapshot: true,
    });
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const gate = createActionGate({ db, ...callbacks, now: () => 100 });
    const result = await gate.handleCall({
      agent_id: "home",
      tick_id: "t1",
      tool: "ha:automation.set",
      args: {},
    });
    expect(result).toEqual({ kind: "rejected", error: "snapshot_failed" });
  });

  test("takeSnapshot honors require_snapshot=true when mcp_allowlist_json is malformed (fail-closed bypass regression)", async () => {
    // Adversarial-review H1: callbacks previously returned `snapshot_skipped_bad_allowlist`
    // unconditionally on JSON.parse failure / non-array — silently fail-open even when
    // the operator opted into require_snapshot. The branch is currently unreachable via
    // action-gate.handleCall (action-gate.ts:89 throws on the same parse first), but the
    // callback owns the contract and the defense-in-depth must honor it.
    const db = setup();
    seedAgent(db, ["ha:automation.set", "ha:ha_backup_create"], [], {
      snapshot_tool: "ha:ha_backup_create",
      require_snapshot: true,
    });
    db.query(
      "UPDATE long_lived_agents SET mcp_allowlist_json = 'not-valid-json' WHERE id = 'home'",
    ).run();
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    let threw: Error | null = null;
    try {
      await callbacks.takeSnapshot("home");
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw!.message).toBe("bad_allowlist");
  });

  test("takeSnapshot returns sentinel when mcp_allowlist_json is malformed and require_snapshot=false", async () => {
    const db = setup();
    seedAgent(db, ["ha:automation.set"], [], { snapshot_tool: "ha:ha_backup_create" });
    db.query(
      "UPDATE long_lived_agents SET mcp_allowlist_json = 'not-valid-json' WHERE id = 'home'",
    ).run();
    const callTool = mock(async () => ({ ok: true }));
    const fakeLog = makeLog();
    const callbacks = buildActionGateCallbacks({
      db,
      mcpPool: { callTool, listTools: mock(async () => []), shutdown: mock(async () => {}) },
      log: fakeLog,
    });
    const result = await callbacks.takeSnapshot("home");
    expect(result).toBe("snapshot_skipped_bad_allowlist");
  });
});
