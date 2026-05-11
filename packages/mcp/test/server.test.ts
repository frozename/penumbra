import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { buildServer } from '../src/server.js';
import { TOOL_REGISTRY } from '../src/tools/registry.js';

const ENV_KEYS = [
  'PENUMBRA_MCP_TOOL_ALLOWLIST',
  'PENUMBRA_LONG_LIVED_AGENT_ID',
  'PENUMBRA_LONG_LIVED_TICK_ID',
  'PENUMBRA_STORAGE_ROOT',
] as const;

const baselineEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const baseline = baselineEnv.get(key);
    if (baseline === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baseline;
    }
  }
});

describe('buildServer tool registration', () => {
  it('registers only allowlisted tools when PENUMBRA_MCP_TOOL_ALLOWLIST is set', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'cost.recent,long_lived_self_state_get';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(['cost.recent', 'long_lived_self_state_get']);
  });

  it('registers all tools when allowlist env is unset', async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(Object.keys(TOOL_REGISTRY).sort());
  });

  it('canonicalizes prefixed penumbra MCP tool ids in allowlist entries', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'mcp__penumbra__cost.recent,mcp__penumbra__long_lived_self_state_get';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(['cost.recent', 'long_lived_self_state_get']);
  });

  it('does not treat non-penumbra MCP-prefixed ids as valid allowlist entries', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'mcp__sirius__cost.recent';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual([]);
  });

  it('fails closed for malformed allowlist tool ids', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'mcp__penumbra_cost.recent,cost.recent';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(['cost.recent']);
  });

  it('long_lived_self_state_get resolves running agent from env context when called without args', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-mcp-server-test-'));
    try {
      process.env.PENUMBRA_STORAGE_ROOT = storageRoot;
      process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'a1';
      process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
      delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;

      const db = new Database(join(storageRoot, 'db.sqlite'));
      try {
        loadSqliteVec(db);
        applySchema(db, { embeddingDim: 384 });
        reconcileLongLivedAgents(
          db,
          [{
            name: 'a1',
            long_lived: true,
            long_lived_config: {
              schedule_cron: '*/15 * * * *',
              subscriptions: [],
              mcp_allowlist: [],
              bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
              circuit_breaker_threshold: 3,
              standing_brief: 'x',
            },
          } as any],
          { now: 1 },
        );
        db.query("INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'a1', 'manual', 1)").run();
      } finally {
        db.close();
      }

      const daemon = {
        getFederationTools: async () => ({ tools: [] }),
        mcpCall: async () => ({ action_status: 'rejected', error: 'unused' }),
      } as any;
      await buildServer({ daemon });
      const handler = TOOL_REGISTRY.long_lived_self_state_get.makeHandler({} as any);
      const result = await handler({});
      const payload = JSON.parse((result as any).content[0].text);
      expect(payload.working_memory.version).toBe(1);
      expect(payload.working_memory.pending_goals).toEqual([]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
