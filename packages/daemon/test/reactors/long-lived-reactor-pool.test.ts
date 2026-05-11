import { describe, it, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { createLongLivedReactor } from '@penumbra/daemon/reactors/long-lived-reactor';
import { createMcpEventBus } from '@penumbra/daemon/events/mcp-event-bus';

function tempDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

describe('long-lived reactor mcp pool bootstrap', () => {
  it('ensures and acquires hosted mcp servers on reload', async () => {
    const db = tempDb();
    const ensureRunning = mock(async () => {});
    const acquire = mock(() => {});
    const fakePool = {
      ensureRunning,
      acquire,
      release: mock(() => {}),
      shutdown: mock(async () => {}),
    };
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: mock(async () => ({ chain_id: 'c1' })),
      isChainActive: () => false,
      now: () => 100,
      log: { warn: mock(() => {}) } as any,
      mcpPool: fakePool as any,
      loadAgentchatYaml: async () => ({
        agents: [{
          name: 'home',
          long_lived: true,
          long_lived_config: {
            schedule_cron: '*/5 * * * *',
            subscriptions: [],
            hosted_mcp_servers: [{
              name: 'echo',
              command: 'bun',
              args: ['run', 'echo-mcp.ts'],
              env: [],
            }],
            mcp_allowlist: [],
            bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
            circuit_breaker_threshold: 3,
            standing_brief: 'x',
          },
        }],
      }),
    });

    await reactor.reload();

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(ensureRunning).toHaveBeenCalledWith({
      name: 'echo',
      command: 'bun',
      args: ['run', 'echo-mcp.ts'],
      env: [],
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith('home', 'echo');
  });

  it('releases removed hosted mcp servers and acquires new ones', async () => {
    const db = tempDb();
    const release = mock(() => {});
    const ensureRunning = mock(async () => {});
    const acquire = mock(() => {});
    let hosted = [{
      name: 'a',
      command: 'bun',
      args: ['run', 'a.ts'],
      env: [],
    }];
    const fakePool = { ensureRunning, acquire, release, shutdown: mock(async () => {}) };
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: mock(async () => ({ chain_id: 'c1' })),
      isChainActive: () => false,
      now: () => 100,
      mcpPool: fakePool as any,
      loadAgentchatYaml: async () => ({
        agents: [{
          name: 'home',
          long_lived: true,
          long_lived_config: {
            subscriptions: [],
            hosted_mcp_servers: hosted,
            mcp_allowlist: [],
            bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
            circuit_breaker_threshold: 3,
            standing_brief: 'x',
          },
        }],
      }),
    });

    await reactor.reload();
    hosted = [{
      name: 'b',
      command: 'bun',
      args: ['run', 'b.ts'],
      env: [],
    }];
    await reactor.reload();

    expect(release).toHaveBeenCalledWith('home', 'a');
    expect(acquire).toHaveBeenCalledWith('home', 'b');
  });

  it('warns when legacy mcpServers remain without federation', async () => {
    const db = tempDb();
    const warn = mock(() => {});
    const fakePool = {
      ensureRunning: mock(async () => {}),
      acquire: mock(() => {}),
      release: mock(() => {}),
      shutdown: mock(async () => {}),
    };
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: mock(async () => ({ chain_id: 'c1' })),
      isChainActive: () => false,
      now: () => 100,
      log: { warn } as any,
      mcpPool: fakePool as any,
      loadAgentchatYaml: async () => ({
        agents: [{
          name: 'home',
          long_lived: true,
          long_lived_config: {
            subscriptions: [],
            hosted_mcp_servers: [],
            mcp_allowlist: [],
            bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
            circuit_breaker_threshold: 3,
            standing_brief: 'x',
          },
          mcpServers: [{ name: 'other' }, { name: 'penumbra' }],
        } as any],
      }),
    });

    await reactor.reload();

    expect(warn).toHaveBeenCalledWith({
      agent_id: 'home',
      mcpServers_non_penumbra: [{ name: 'other' }],
      msg: 'long-lived agent uses non-federated MCP servers; action-gate will not enforce on these tools',
    });
  });

  it('shuts down the mcp pool', async () => {
    const db = tempDb();
    const shutdown = mock(async () => {});
    const fakePool = {
      ensureRunning: mock(async () => {}),
      acquire: mock(() => {}),
      release: mock(() => {}),
      shutdown,
    };
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: mock(async () => ({ chain_id: 'c1' })),
      isChainActive: () => false,
      now: () => 100,
      log: { warn: mock(() => {}) } as any,
      mcpPool: fakePool as any,
      loadAgentchatYaml: async () => ({ agents: [] }),
    });

    reactor.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
