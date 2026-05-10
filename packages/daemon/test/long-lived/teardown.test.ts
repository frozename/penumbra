import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '../../src/long-lived/reconciler.js';
import { handleTickTeardown } from '../../src/long-lived/teardown.js';

function seed(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [{
    name: 'a',
    long_lived: true,
    long_lived_config: {
      schedule_cron: '*/15 * * * *',
      subscriptions: [],
      mcp_allowlist: [],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'cron', 1)").run();
  return db;
}

describe('handleTickTeardown', () => {
  it('on success, resets consecutive_failures, writes outcome + cost', () => {
    const db = seed();
    db.query("UPDATE long_lived_agents SET consecutive_failures=2 WHERE id='a'").run();

    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'success', cost_cents: 7, now: 100 });

    const tick = db.query("SELECT outcome, cost_cents, completed_at FROM long_lived_ticks WHERE id='t1'").get() as any;
    expect(tick.outcome).toBe('success');
    expect(tick.cost_cents).toBe(7);
    expect(tick.completed_at).toBe(100);

    const agent = db.query("SELECT consecutive_failures, last_tick_outcome FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.consecutive_failures).toBe(0);
    expect(agent.last_tick_outcome).toBe('success');
  });

  it('on failure, increments consecutive_failures', () => {
    const db = seed();

    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'failed', error: 'boom', now: 100 });

    const agent = db.query("SELECT consecutive_failures, status FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.consecutive_failures).toBe(1);
    expect(agent.status).toBe('active');
  });

  it('trips circuit breaker at threshold', () => {
    const db = seed();
    db.query("UPDATE long_lived_agents SET consecutive_failures=2, circuit_breaker_threshold=3 WHERE id='a'").run();

    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'failed', error: 'boom', now: 100 });

    const agent = db.query("SELECT status, degraded_reason FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.status).toBe('degraded');
    expect(agent.degraded_reason).toContain('boom');
  });

  it('bound_exceeded counts as failure', () => {
    const db = seed();

    handleTickTeardown(db, { tick_id: 't1', agent_id: 'a', outcome: 'bound_exceeded', now: 100 });

    const agent = db.query("SELECT consecutive_failures FROM long_lived_agents WHERE id='a'").get() as any;
    expect(agent.consecutive_failures).toBe(1);
  });
});
