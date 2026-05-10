import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { createLongLivedReactor } from '@penumbra/daemon/reactors/long-lived-reactor';
import { createMcpEventBus } from '@penumbra/daemon/events/mcp-event-bus';

const fakeAgent = {
  name: 'home',
  long_lived: true,
  long_lived_config: {
    schedule_cron: '*/5 * * * *',
    subscriptions: [{ server: 'ha', event: 'state_changed' }],
    mcp_allowlist: ['ha:state.*'],
    bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
    circuit_breaker_threshold: 3,
    standing_brief: 'x',
  },
};

describe('long-lived reactor', () => {
  it('reconciles, registers a cron job, and fires spawn on cron testFire', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock(async () => ({ chain_id: 'ch1' }));
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      loadAgentchatYaml: async () => ({ agents: [fakeAgent] }),
    });

    await reactor.reload();
    reactor._cronTestFire('home');

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('subscribes to MCP events and fires spawn on a matching publish', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock(async () => ({ chain_id: 'ch1' }));
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      loadAgentchatYaml: async () => ({ agents: [fakeAgent] }),
    });

    await reactor.reload();
    bus.publish({ server: 'ha', event: 'state_changed', payload: { entity_id: 'light.kitchen' }, published_at: 100 });
    await Bun.sleep(20);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reload diff retires removed agents', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock(async () => ({ chain_id: 'c' }));
    let yamlAgents = [fakeAgent];
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      loadAgentchatYaml: async () => ({ agents: yamlAgents }),
    });

    await reactor.reload();
    expect(reactor._cronList()).toEqual([
      'home',
      '__sweeper_pending_expiry__',
      '__sweeper_snapshot_purge__',
    ]);

    yamlAgents = [];
    await reactor.reload();

    expect(reactor._cronList()).toEqual([
      '__sweeper_pending_expiry__',
      '__sweeper_snapshot_purge__',
    ]);
    const row = db.query("SELECT status FROM long_lived_agents WHERE id='home'").get() as any;
    expect(row.status).toBe('retired');
  });

  it('registers the long-lived sweepers on reload', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock(async () => ({ chain_id: 'c' }));
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      loadAgentchatYaml: async () => ({ agents: [] }),
    });

    await reactor.reload();

    expect(reactor._cronList()).toEqual([
      '__sweeper_pending_expiry__',
      '__sweeper_snapshot_purge__',
    ]);
  });
});
