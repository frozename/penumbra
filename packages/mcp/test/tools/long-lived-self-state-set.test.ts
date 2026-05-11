import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedSelfStateSet } from '@penumbra/mcp/tools/long-lived-self-state-set';

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [{
    name: 'a', long_lived: true, long_lived_config: {
      schedule_cron: '*/15 * * * *', subscriptions: [], mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3, standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-a', 'a', 'manual', 1)").run();
}

describe('long_lived_self_state_set', () => {
  it('updates intent_summary atomically', async () => {
    const db = new Database(':memory:'); seed(db);
    await handleLongLivedSelfStateSet(db, { running_agent_id: 'a', running_tick_id: 'tick-a' }, { intent_summary: 'checking the dryer' });
    const row = db.query("SELECT last_intent_summary FROM long_lived_agents WHERE id='a'").get() as any;
    expect(row.last_intent_summary).toBe('checking the dryer');
  });

  it('replaces working_memory when provided (full replacement, not merge)', async () => {
    const db = new Database(':memory:'); seed(db);
    const wm = { version: 1, updated_at: 5, pending_goals: [], open_threads: [{ id: 'o1', topic: 't', opened_at: 1, notes: '' }], watches: [], recent_decisions: [] };
    await handleLongLivedSelfStateSet(db, { running_agent_id: 'a', running_tick_id: 'tick-a' }, { working_memory: wm });
    const row = db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any;
    expect(JSON.parse(row.working_memory_json).open_threads).toHaveLength(1);
  });

  it('rejects invalid working memory', async () => {
    const db = new Database(':memory:'); seed(db);
    await expect(handleLongLivedSelfStateSet(db, { running_agent_id: 'a', running_tick_id: 'tick-a' }, { working_memory: { version: 99 } as any })).rejects.toThrow();
  });

  it('errors when not in a running tick', async () => {
    const db = new Database(':memory:'); seed(db);
    await expect(handleLongLivedSelfStateSet(db, {}, { intent_summary: 'x' })).rejects.toThrow(/no_running_long_lived_tick/);
  });

  it('errors with cross_identity_long_lived when tick belongs to another agent', async () => {
    const db = new Database(':memory:'); seed(db);
    reconcileLongLivedAgents(db, [{
      name: 'b', long_lived: true, long_lived_config: {
        schedule_cron: '*/15 * * * *', subscriptions: [], mcp_allowlist: [],
        bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
        circuit_breaker_threshold: 3, standing_brief: 'y',
      },
    } as any], { now: 1 });
    db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-b', 'b', 'manual', 1)").run();
    await expect(
      handleLongLivedSelfStateSet(
        db,
        { running_agent_id: 'a', running_tick_id: 'tick-b' },
        { intent_summary: 'x' },
      ),
    ).rejects.toThrow(/cross_identity_long_lived/);
  });
});
