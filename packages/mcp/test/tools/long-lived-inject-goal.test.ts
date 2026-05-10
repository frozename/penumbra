import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { handleLongLivedInjectGoal } from '@penumbra/mcp/tools/long-lived-inject-goal';

function seed(db: Database, scheduleCron: string | null) {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [{
    name: 'a',
    long_lived: true,
    long_lived_config: {
      schedule_cron: scheduleCron ?? undefined,
      subscriptions: [],
      mcp_allowlist: [],
      bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: 'x',
    },
  } as any], { now: 1 });
}

describe('long_lived_inject_goal', () => {
  it('appends a user_goal to pending_goals', async () => {
    const db = new Database(':memory:');
    seed(db, '*/15 * * * *');
    const fireTick = mock(() => {});

    const result = await handleLongLivedInjectGoal(db, { fireTick, now: () => 5 }, { id: 'a', goal: 'check the dryer' });

    expect(result.ok).toBe(true);
    const wm = JSON.parse((db.query("SELECT working_memory_json FROM long_lived_agents WHERE id='a'").get() as any).working_memory_json);
    expect(wm.pending_goals).toHaveLength(1);
    expect(wm.pending_goals[0]).toMatchObject({ kind: 'user_goal', text: 'check the dryer' });
    expect(fireTick).not.toHaveBeenCalled();
  });

  it('fires an injected_goal tick when the agent has no schedule', async () => {
    const db = new Database(':memory:');
    seed(db, null);
    const fireTick = mock(() => {});

    await handleLongLivedInjectGoal(db, { fireTick, now: () => 5 }, { id: 'a', goal: 'do thing' });

    expect(fireTick).toHaveBeenCalledTimes(1);
    expect(fireTick).toHaveBeenCalledWith({ agent_id: 'a', trigger_kind: 'injected_goal' });
  });

  it('rejects retired agents', async () => {
    const db = new Database(':memory:');
    seed(db, '*/1 * * * *');
    db.query("UPDATE long_lived_agents SET status='retired' WHERE id='a'").run();

    await expect(handleLongLivedInjectGoal(db, { fireTick: () => {}, now: () => 5 }, { id: 'a', goal: 'x' })).rejects.toThrow(/not_active/);
  });
});
