import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSqliteVec } from '@penumbra/core';
import { applySchema } from '@penumbra/core/db/schema';
import { reconcileLongLivedAgents } from '@penumbra/daemon/long-lived/reconciler';
import { openInvocationSink } from '../src/invocation-sink.js';
import * as registry from '../src/invocation-sink-registry.js';
import { buildServer } from '../src/server.js';
import { TOOL_REGISTRY } from '../src/tools/registry.js';

const ENV_KEYS = [
  'PENUMBRA_MCP_TOOL_ALLOWLIST',
  'PENUMBRA_MCP_INVOCATION_LOG_ENABLED',
  'PENUMBRA_LONG_LIVED_AGENT_ID',
  'PENUMBRA_LONG_LIVED_TICK_ID',
  'PENUMBRA_STORAGE_ROOT',
  'XDG_STATE_HOME',
] as const;

const baselineEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(async () => {
  mock.restore();
  await registry.closeSink();
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
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'cost_recent,long_lived_self_state_get';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(['cost_recent', 'long_lived_self_state_get']);
  });

  it('registers all tools when allowlist env is unset', async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(Object.keys(TOOL_REGISTRY).sort());
  });

  it('canonicalizes mcp__penumbra__ wire-form prefixed ids in allowlist entries', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'mcp__penumbra__cost_recent,mcp__penumbra__long_lived_self_state_get';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(['cost_recent', 'long_lived_self_state_get']);
  });

  it('canonicalizes penumbra: short-form allowlist entries', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'penumbra:cost_recent,penumbra:long_lived_self_state_get';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(['cost_recent', 'long_lived_self_state_get']);
  });

  it('passes through non-penumbra prefixed entries unchanged for federation matching', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'ha.ha_get_state,ha.ha_call_service';
    process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
    process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
    const server = await buildServer({
      daemon: {
        getFederationTools: async () => ({ tools: [{ name: 'ha.ha_get_state' }, { name: 'ha.ha_call_service' }] }),
        mcpCall: async () => ({ action_status: 'executed', result: {} }),
      } as any,
    }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toContain('ha.ha_get_state');
    expect(names).toContain('ha.ha_call_service');
  });

  it('does not treat non-penumbra MCP-prefixed ids as valid allowlist entries', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'mcp__sirius__cost_recent';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual([]);
  });

  it('fails closed for malformed allowlist tool ids', async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'mcp__penumbra_cost_recent,cost_recent';
    const server = await buildServer({ daemon: {} as any }) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(['cost_recent']);
  });

  it('emits federation registration health to stderr', async () => {
    let line = '';
    const error = mock((msg: string) => {
      line = msg;
    });
    const original = console.error;
    console.error = error as any;
    try {
      const daemon = {
        getFederationTools: async () => ({ tools: [{ name: 'ha_get_state' }] }),
        mcpCall: async () => ({ action_status: 'rejected', error: 'unused' }),
      } as any;
      delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
      await buildServer({ daemon });
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.parse(line)).toEqual({
        event: 'federation.registered',
        registered_count: 0,
        skipped_count: 0,
        skipped: [],
      });
    } finally {
      console.error = original;
    }
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

  it('PENUMBRA_MCP_INVOCATION_LOG_ENABLED=1: registered tool produces a log row', async () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = '1';
    const stateRoot = mkdtempSync(join(tmpdir(), 'penumbra-mcp-log-state-'));
    process.env.XDG_STATE_HOME = stateRoot;
    const logPath = join(stateRoot, 'penumbra', 'mcp-invocations.jsonl');
    const sink = openInvocationSink(logPath);
    spyOn(registry, 'getSink').mockReturnValue(sink);
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'test_phase4_tool';
    const original = (TOOL_REGISTRY as any).test_phase4_tool;
    (TOOL_REGISTRY as any).test_phase4_tool = {
      descriptor: { description: 'phase4 test tool', inputSchema: {} },
      makeHandler: () => async () => ({ ok: true }),
      readOnly: true,
    };
    try {
      const server = await buildServer({ daemon: {} as any }) as any;
      await server._registeredTools.test_phase4_tool.handler({}, { _meta: { origin: 'test-suite' } });
      await sink.close();
      const text = readFileSync(logPath, 'utf8').trim();
      const rows = text.length === 0
        ? []
        : text.split('\n').map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0].tool).toBe('test_phase4_tool');
    } finally {
      if (original === undefined) {
        delete (TOOL_REGISTRY as any).test_phase4_tool;
      } else {
        (TOOL_REGISTRY as any).test_phase4_tool = original;
      }
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('PENUMBRA_MCP_INVOCATION_LOG_ENABLED unset: registered tool produces no log writes', async () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = 'test_phase4_tool_disabled';
    const getSinkSpy = spyOn(registry, 'getSink');
    const original = (TOOL_REGISTRY as any).test_phase4_tool_disabled;
    (TOOL_REGISTRY as any).test_phase4_tool_disabled = {
      descriptor: { description: 'phase4 disabled test tool', inputSchema: {} },
      makeHandler: () => async () => ({ ok: true }),
      readOnly: true,
    };
    try {
      const server = await buildServer({ daemon: {} as any }) as any;
      await server._registeredTools.test_phase4_tool_disabled.handler({}, { _meta: { origin: 'test-suite' } });
      expect(getSinkSpy).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete (TOOL_REGISTRY as any).test_phase4_tool_disabled;
      } else {
        (TOOL_REGISTRY as any).test_phase4_tool_disabled = original;
      }
    }
  });
});
