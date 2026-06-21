import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, NotificationOutboxWriter } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { DispatchEventKindSchema } from "@penumbra/api-contract";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { runPendingExpiry } from "@penumbra/daemon/long-lived/pending-expiry";

function setup(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "home",
        long_lived: true,
        long_lived_config: {
          schedule_cron: "*/15 * * * *",
          subscriptions: [],
          mcp_allowlist: ["ha:light.*"],
          bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3,
          standing_brief: "x",
        },
      } as any,
    ],
    { now: 100 },
  );
  return db;
}

describe("runPendingExpiry", () => {
  it("expires overdue pending actions and records an expired decision", () => {
    const db = setup();
    db.query(
      `
      INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at)
      VALUES ('tick-1', 'home', 'manual', 100)
    `,
    ).run();
    db.query(
      `
      INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json,
        status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
    ).run("pa-expired", "home", "tick-1", "ha:light.turn_on", "light.kitchen", "{}", 50, 100);
    db.query(
      `
      INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json,
        status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
    ).run("pa-future", "home", "tick-1", "ha:light.turn_off", "light.office", "{}", 150, 100);

    const result = runPendingExpiry(db, { now: 100 });

    expect(result.expired).toBe(1);

    const expired = db
      .query("SELECT status, decided_by FROM long_lived_pending_actions WHERE id='pa-expired'")
      .get() as any;
    expect(expired.status).toBe("expired");
    expect(expired.decided_by).toBe("auto-expired");

    const future = db
      .query("SELECT status, decided_by FROM long_lived_pending_actions WHERE id='pa-future'")
      .get() as any;
    expect(future.status).toBe("pending");
    expect(future.decided_by).toBeNull();

    const wm = db
      .query("SELECT working_memory_json FROM long_lived_agents WHERE id='home'")
      .get() as any;
    const parsed = JSON.parse(wm.working_memory_json);
    expect(parsed.recent_decisions).toEqual([
      { pending_action_id: "pa-expired", decision: "expired", decided_at: 100 },
    ]);
    expect(parsed.updated_at).toBe(100);
  });

  it("writes an audit row when expiring a pending action", () => {
    const db = setup();
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'home', 'manual', 100)`,
    ).run();
    db.query(
      `INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa-1', 'home', 'tick-1', 'ha:light.turn_on', 'light.kitchen', '{}', 'pending', 50, 100)`,
    ).run();

    runPendingExpiry(db, { now: 100 });

    const audit = db
      .query<
        { decision: string; reason: string },
        []
      >("SELECT decision, reason FROM long_lived_action_audit WHERE pending_action_id='pa-1'")
      .get();
    expect(audit).not.toBeNull();
    expect(audit!.decision).toBe("expired");
    expect(audit!.reason).toBe("auto_expired_ttl");
  });

  it("records a dispatch event when expiring a pending action", () => {
    const db = setup();
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'home', 'manual', 100)`,
    ).run();
    db.query(
      `INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa-dispatch', 'home', 'tick-1', 'ha:light.turn_on', 'light.kitchen', '{}', 'pending', 50, 100)`,
    ).run();

    const dispatchEvents: Array<{
      handoff_id: string;
      worker_id: string | null;
      source: string;
      kind: string;
      ts: string;
      meta: Record<string, unknown>;
    }> = [];
    const dispatchEventLog = {
      record(event: (typeof dispatchEvents)[0]) {
        dispatchEvents.push(event);
      },
    };

    runPendingExpiry(db, { now: 100, dispatchEventLog });

    expect(dispatchEvents.length).toBe(1);
    expect(dispatchEvents[0].kind).toBe("long_lived.action.expired");
    expect(dispatchEvents[0].source).toBe("daemon");
    expect(dispatchEvents[0].meta).toMatchObject({
      action_id: "pa-dispatch",
      agent_id: "home",
      action_kind: "ha:light.turn_on",
      action_target: "light.kitchen",
      reason: "auto_expired_ttl",
    });
  });

  it("enqueues a notification outbox entry when expiring a pending action", () => {
    const db = setup();
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'home', 'manual', 100)`,
    ).run();
    db.query(
      `INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa-notify', 'home', 'tick-1', 'ha:light.turn_on', 'light.kitchen', '{}', 'pending', 50, 100)`,
    ).run();

    const outbox = new NotificationOutboxWriter(db);

    runPendingExpiry(db, { now: 100, notificationOutbox: outbox });

    expect(outbox.exists("pending_action_expired", "pa-notify")).toBe(true);

    const row = db
      .query<
        { kind: string; summary: string | null },
        [string]
      >("SELECT kind, summary FROM notification_outbox WHERE kind='pending_action_expired' AND reference_id='pa-notify'")
      .get();
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("pending_action_expired");
    expect(row!.summary).toContain("Expired");
  });

  it("does not record dispatch event or notification when no deps provided (backward compat)", () => {
    const db = setup();
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'home', 'manual', 100)`,
    ).run();
    db.query(
      `INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa-bc', 'home', 'tick-1', 'ha:light.turn_on', 'light.hall', '{}', 'pending', 50, 100)`,
    ).run();

    const result = runPendingExpiry(db, { now: 100 });
    expect(result.expired).toBe(1);

    const dispatchRows = db
      .query("SELECT * FROM dispatch_events WHERE kind='long_lived.action.expired'")
      .all();
    expect(dispatchRows.length).toBe(0);

    const outboxRows = db
      .query("SELECT * FROM notification_outbox WHERE kind='pending_action_expired'")
      .all();
    expect(outboxRows.length).toBe(0);
  });

  it("uses project_id from agent in notification outbox entry", () => {
    const db = setup();
    db.prepare(`UPDATE long_lived_agents SET project_id = ? WHERE id = ?`).run(
      "my-project",
      "home",
    );
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'home', 'manual', 100)`,
    ).run();
    db.query(
      `INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa-proj', 'home', 'tick-1', 'ha:light.turn_on', 'light.bedroom', '{}', 'pending', 50, 100)`,
    ).run();

    const outbox = new NotificationOutboxWriter(db);
    runPendingExpiry(db, { now: 100, notificationOutbox: outbox });

    const row = db
      .query<
        { project_id: string | null; coalesce_key: string },
        [string]
      >("SELECT project_id, coalesce_key FROM notification_outbox WHERE reference_id='pa-proj'")
      .get();
    expect(row).not.toBeNull();
    expect(row!.project_id).toBe("my-project");
    expect(row!.coalesce_key).toBe("my-project");
  });

  it("long_lived.action.expired is in the dispatch event kind whitelist", () => {
    const kinds = DispatchEventKindSchema.options as string[];
    expect(kinds).toContain("long_lived.action.expired");
  });

  it("per-action body is atomic: rolls back pending-action + audit writes if the working_memory step throws", () => {
    const db = setup();
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'home', 'manual', 100)`,
    ).run();
    db.query(
      `INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa-atomic', 'home', 'tick-1', 'ha:light.turn_on', 'light.kitchen', '{}', 'pending', 50, 100)`,
    ).run();

    // Corrupt working_memory_json so the JSON.parse step inside the per-action
    // body throws. The fixed implementation wraps the body in db.transaction,
    // so the earlier pending-action UPDATE and audit INSERT must be rolled back.
    db.query(
      `UPDATE long_lived_agents SET working_memory_json='{not-valid-json' WHERE id='home'`,
    ).run();

    expect(() => runPendingExpiry(db, { now: 100 })).toThrow();

    const pa = db
      .query<
        { status: string; decided_by: string | null },
        []
      >("SELECT status, decided_by FROM long_lived_pending_actions WHERE id='pa-atomic'")
      .get();
    expect(pa).not.toBeNull();
    expect(pa!.status).toBe("pending");
    expect(pa!.decided_by).toBeNull();

    const auditCount = db
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM long_lived_action_audit WHERE pending_action_id='pa-atomic'")
      .get();
    expect(auditCount!.n).toBe(0);
  });
});
