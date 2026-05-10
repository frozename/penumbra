import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedGet } from '@penumbra/mcp/tools/long-lived-get';

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [{
    name: 'home-mgmt',
    display_name: 'Home Mgmt',
    long_lived: true,
    long_lived_config: {
      schedule_cron: '*/15 * * * *',
      subscriptions: [{ server: 'ha', event: 'state_changed' }],
      mcp_allowlist: ['ha:state.*'],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: 'watch home state',
    },
  } as any], { now: 1 });
}

describe('long_lived_get', () => {
  it('returns full agent detail with recent related rows', async () => {
    const db = new Database(':memory:');
    seed(db);
    db.query(
      `INSERT INTO long_lived_ticks (
        id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
        completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'tick-1',
      'home-mgmt',
      'chain-1',
      'cron',
      JSON.stringify({ scheduled: true }),
      'check the house',
      1000,
      2000,
      'success',
      12,
      null,
      JSON.stringify({}),
    );
    db.query(
      `INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
        status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'action-1',
      'home-mgmt',
      'tick-1',
      'notify',
      'ha:state',
      JSON.stringify({ message: 'ping' }),
      'needs attention',
      'pending',
      999999,
      null,
      null,
      null,
      1500,
    );
    db.query(
      `INSERT INTO long_lived_action_audit (
        agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'home-mgmt',
      'tick-1',
      'action-1',
      'notify',
      'ha:state',
      'approved',
      null,
      1600,
    );

    const result = await handleLongLivedGet(db, { id: 'home-mgmt' });

    expect(result.agent.id).toBe('home-mgmt');
    expect(result.agent.working_memory.version).toBe(1);
    expect(result.recent_ticks).toHaveLength(1);
    expect(result.recent_ticks[0].trigger_payload).toEqual({ scheduled: true });
    expect(result.pending_actions[0].payload).toEqual({ message: 'ping' });
    expect(result.recent_audit[0].decision).toBe('approved');
  });

  it('rejects missing ids', async () => {
    const db = new Database(':memory:');
    seed(db);
    await expect(handleLongLivedGet(db, {})).rejects.toThrow();
  });
});
