import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedAudit } from '@penumbra/mcp/tools/long-lived-audit';

function seed(db: Database) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [{
    name: 'a',
    long_lived: true,
    long_lived_config: {
      schedule_cron: '*/1 * * * *',
      subscriptions: [],
      mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query("INSERT INTO long_lived_action_audit (id, agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at) VALUES (1, 'a', 't1', 'p1', 'ha:test', 'target', 'approved', null, 100)").run();
  db.query("INSERT INTO long_lived_action_audit (id, agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at) VALUES (2, 'a', 't2', 'p2', 'ha:test', 'target', 'rejected', 'too risky', 200)").run();
}

describe('long_lived_audit', () => {
  it('filters by since and limit', async () => {
    const db = new Database(':memory:');
    seed(db);

    const result = await handleLongLivedAudit(db, { id: 'a', since: 150, limit: 1 });

    expect(result.audit).toHaveLength(1);
    expect(result.audit[0].id).toBe(2);
    expect(result.audit[0].pending_action_id).toBe('p2');
  });

  it('defaults limit to 100', async () => {
    const db = new Database(':memory:');
    seed(db);

    const result = await handleLongLivedAudit(db, { id: 'a' });
    expect(result.audit).toHaveLength(2);
  });
});
