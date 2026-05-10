import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedStateSet } from '@penumbra/mcp/tools/long-lived-state-set';

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [{
    name: 'a',
    display_name: 'A',
    long_lived: true,
    long_lived_config: {
      schedule_cron: '*/15 * * * *',
      subscriptions: [],
      mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: 'x',
    },
  } as any], { now: 1 });
}

describe('long_lived_state_set', () => {
  it('updates intent summary and working memory atomically', async () => {
    const db = new Database(':memory:');
    seed(db);
    const wm = { version: 1, updated_at: 5, pending_goals: [], open_threads: [], watches: [], recent_decisions: [] };

    await handleLongLivedStateSet(db, { id: 'a', partial: { intent_summary: 'checking', working_memory: wm } });

    const row = db.query("SELECT last_intent_summary, working_memory_json FROM long_lived_agents WHERE id='a'").get() as any;
    expect(row.last_intent_summary).toBe('checking');
    expect(JSON.parse(row.working_memory_json).updated_at).toBeGreaterThan(0);
  });
});
