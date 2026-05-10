import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedSelfStateGet } from '@penumbra/mcp/tools/long-lived-self-state-get';

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
}

describe('long_lived_self_state_get', () => {
  it('returns the running agent\'s working memory', async () => {
    const db = new Database(':memory:'); seed(db);
    const result = await handleLongLivedSelfStateGet(db, { running_agent_id: 'a' }, {});
    expect(result.working_memory.version).toBe(1);
    expect(result.working_memory.pending_goals).toEqual([]);
  });

  it('errors when running_agent_id is missing', async () => {
    const db = new Database(':memory:'); seed(db);
    await expect(handleLongLivedSelfStateGet(db, {}, {})).rejects.toThrow(/no_running_long_lived_tick/);
  });
});
