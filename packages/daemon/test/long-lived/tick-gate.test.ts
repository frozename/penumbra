import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { createTickGate, type TickAttempt } from '@penumbra/daemon/long-lived/tick-gate';

function seedAgent(db: Database, opts: { status?: string; lastStartedAt?: number | null } = {}) {
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: '*/15 * * * *',
      subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("UPDATE long_lived_agents SET status=?, last_tick_started_at=? WHERE id='a'")
    .run(opts.status ?? 'active', opts.lastStartedAt ?? null);
}

describe('tick-gate', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
  });

  it('passes when agent is active and no in-flight tick', () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: 'ch1', tick_id: 't1' }));
    const isChainActive = () => false;
    const gate = createTickGate({ db, spawn, isChainActive, now: () => 100 });
    const attempt: TickAttempt = { agent_id: 'a', trigger_kind: 'cron' };
    const result = gate.attempt(attempt);
    expect(result.outcome).toBe('spawned');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('blocks paused/degraded/retired with circuit_open row and no spawn', () => {
    for (const status of ['paused', 'degraded', 'retired']) {
      const localDb = new Database(':memory:');
      loadSqliteVec(localDb);
      applySchema(localDb, { embeddingDim: 384 });
      seedAgent(localDb, { status });
      const spawn = mock(() => ({ chain_id: 'ch', tick_id: 't' }));
      const gate = createTickGate({ db: localDb, spawn, isChainActive: () => false, now: () => 100 });
      const r = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
      expect(r.outcome).toBe('skipped_status');
      expect(spawn).not.toHaveBeenCalled();
      const tickRow = localDb.query("SELECT outcome FROM long_lived_ticks WHERE agent_id='a'").get() as any;
      expect(tickRow.outcome).toBe('circuit_open');
    }
  });

  it('blocks when in-flight tick is active (concurrency skip)', () => {
    seedAgent(db, { lastStartedAt: 50 });
    const spawn = mock(() => ({ chain_id: 'ch1', tick_id: 't1' }));
    const isChainActive = () => true;
    const gate = createTickGate({ db, spawn, isChainActive, now: () => 100 });
    const r = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
    expect(r.outcome).toBe('concurrency_skip');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('coalesces a burst of identical events to a single spawn within 1s', () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: 'ch1', tick_id: 't1' }));
    const gate = createTickGate({ db, spawn, isChainActive: () => false, now: () => 100 });
    for (let i = 0; i < 50; i++) {
      gate.attempt({ agent_id: 'a', trigger_kind: 'event', trigger_payload: { server: 'ha', event: 'state_changed', i }, debounce_key: 'ha:state_changed' });
    }
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cron triggers do NOT debounce', () => {
    seedAgent(db);
    const spawn = mock(() => ({ chain_id: 'c', tick_id: 't' }));
    let active = false;
    const gate = createTickGate({
      db,
      spawn: () => { active = true; return { chain_id: 'c', tick_id: 't' }; },
      isChainActive: () => active,
      now: () => 100,
    });
    const r1 = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
    expect(r1.outcome).toBe('spawned');
    const r2 = gate.attempt({ agent_id: 'a', trigger_kind: 'cron' });
    expect(r2.outcome).toBe('concurrency_skip');
  });
});
