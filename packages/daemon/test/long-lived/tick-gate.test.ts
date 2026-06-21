import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import {
  createTickGate,
  PENDING_CHAIN_SENTINEL,
  reconcileOrphanTickRows,
  type TickAttempt,
} from "@penumbra/daemon/long-lived/tick-gate";

function seedAgent(db: Database, opts: { status?: string; lastStartedAt?: number | null } = {}) {
  reconcileLongLivedAgents(
    db,
    [
      {
        name: "a",
        long_lived: true,
        long_lived_config: {
          schedule_cron: "*/15 * * * *",
          subscriptions: [],
          mcp_allowlist: [],
          bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
          circuit_breaker_threshold: 3,
          standing_brief: "x",
        },
      } as any,
    ],
    { now: 1 },
  );
  db.query("UPDATE long_lived_agents SET status=?, last_tick_started_at=? WHERE id='a'").run(
    opts.status ?? "active",
    opts.lastStartedAt ?? null,
  );
}

describe("tick-gate", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
  });

  it("passes when agent is active and no in-flight tick", () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: "ch1", tick_id: "t1" }));
    const isChainActive = () => false;
    const gate = createTickGate({ db, spawn, isChainActive, now: () => 100 });
    const attempt: TickAttempt = { agent_id: "a", trigger_kind: "cron" };
    const result = gate.attempt(attempt);
    expect(result.outcome).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("blocks paused/degraded/retired with circuit_open row and no spawn", () => {
    for (const status of ["paused", "degraded", "retired"]) {
      const localDb = new Database(":memory:");
      loadSqliteVec(localDb);
      applySchema(localDb, { embeddingDim: 384 });
      seedAgent(localDb, { status });
      const spawn = mock(() => ({ chain_id: "ch", tick_id: "t" }));
      const gate = createTickGate({
        db: localDb,
        spawn,
        isChainActive: () => false,
        now: () => 100,
      });
      const r = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
      expect(r.outcome).toBe("skipped_status");
      expect(spawn).not.toHaveBeenCalled();
      const tickRow = localDb
        .query("SELECT outcome FROM long_lived_ticks WHERE agent_id='a'")
        .get() as any;
      expect(tickRow.outcome).toBe("circuit_open");
    }
  });

  it("blocks when in-flight tick is active (concurrency skip)", () => {
    seedAgent(db, { lastStartedAt: 50 });
    const spawn = mock(() => ({ chain_id: "ch1", tick_id: "t1" }));
    const isChainActive = () => true;
    const gate = createTickGate({ db, spawn, isChainActive, now: () => 100 });
    const r = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r.outcome).toBe("concurrency_skip");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("coalesces a burst of identical events to a single spawn within 1s", () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: "ch1", tick_id: "t1" }));
    const gate = createTickGate({ db, spawn, isChainActive: () => false, now: () => 100 });
    for (let i = 0; i < 50; i++) {
      gate.attempt({
        agent_id: "a",
        trigger_kind: "event",
        trigger_payload: { server: "ha", event: "state_changed", i },
        debounce_key: "ha:state_changed",
      });
    }
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("cron triggers do NOT debounce", () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: "c", tick_id: "t" }));
    let active = false;
    const gate = createTickGate({
      db,
      spawn: () => {
        active = true;
        return { chain_id: "c", tick_id: "t" };
      },
      isChainActive: () => active,
      now: () => 100,
    });
    const r1 = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r1.outcome).toBe("spawned");
    const r2 = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r2.outcome).toBe("concurrency_skip");
  });

  it("concurrency_skip rows do not shadow an in-flight spawn", () => {
    seedAgent(db);
    let active = false;
    const spawn = mock(() => {
      active = true;
      return { chain_id: "c", tick_id: "t" };
    });
    const gate = createTickGate({
      db,
      spawn,
      isChainActive: () => active,
      now: (() => {
        const times = [100, 200, 300];
        let i = 0;
        return () => times[i++] ?? times[times.length - 1];
      })(),
    });

    const r1 = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r1.outcome).toBe("spawned");
    const r2 = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r2.outcome).toBe("concurrency_skip");
    const r3 = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r3.outcome).toBe("concurrency_skip");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("treats a pending-sentinel tick as in-flight across the cold-start window", () => {
    seedAgent(db);
    let spawnCount = 0;
    const spawn = mock(() => {
      spawnCount++;
      return { chain_id: PENDING_CHAIN_SENTINEL, tick_id: "irrelevant" };
    });
    // Cold-start: no handoff is registered for "pending" yet.
    const isChainActive = (chain_id: string) => chain_id !== PENDING_CHAIN_SENTINEL;
    let nowVal = 100;
    const gate = createTickGate({
      db,
      spawn,
      isChainActive,
      now: () => nowVal,
      debounceWindowMs: 1000,
    });

    const r1 = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r1.outcome).toBe("spawned");
    expect(spawnCount).toBe(1);

    // Advance past the 1s debounce window while the spawn is still mid cold-start
    // (chain_id is still the "pending" sentinel; no real handoff exists yet).
    nowVal = 5100;
    const r2 = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r2.outcome).toBe("concurrency_skip");
    expect(spawnCount).toBe(1);
  });

  it("treats an in-flight tick with NULL chain_id (pre-spawn) as active", () => {
    seedAgent(db);
    // Simulate the race window: tick INSERT committed by the gate's transaction
    // but spawn() has not yet stamped a chain_id.
    db.query(
      `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at)
       VALUES (?, ?, ?, ?)`,
    ).run("tick-prespawn", "a", "cron", 50);
    db.query("UPDATE long_lived_agents SET last_tick_started_at=? WHERE id='a'").run(50);

    const spawn = mock(() => ({ chain_id: "ch-new", tick_id: "t-new" }));
    const gate = createTickGate({
      db,
      spawn,
      isChainActive: () => false,
      now: () => 5050, // well past the 1s debounce window
      debounceWindowMs: 1000,
    });
    const r = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(r.outcome).toBe("concurrency_skip");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reconciles an orphaned in-flight tick when the last chain is inactive", () => {
    seedAgent(db, { lastStartedAt: 1 });
    db.query(
      `INSERT INTO long_lived_ticks (
        id, agent_id, chain_id, trigger_kind, started_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run("tick-orphan", "a", "conv-abc", "cron", 10);

    const spawn = mock(() => ({ chain_id: "conv-new", tick_id: "tick-new" }));
    const gate = createTickGate({
      db,
      spawn,
      isChainActive: (chain_id) => chain_id === "some-other-chain",
      now: () => 2000,
    });

    const result = gate.attempt({ agent_id: "a", trigger_kind: "cron" });
    expect(result.outcome).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);

    const orphanRow = db
      .query(
        `SELECT completed_at, outcome, error_summary
       FROM long_lived_ticks
       WHERE id = 'tick-orphan'`,
      )
      .get() as any;
    expect(orphanRow.completed_at).not.toBeNull();
    expect(orphanRow.outcome).toBe("orphan_recovered");
    expect(orphanRow.error_summary).toBe("chain reported inactive at next tick attempt");
  });
});
