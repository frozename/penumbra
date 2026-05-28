import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFederatedTools } from '../../src/federation/client.js';
import { openInvocationSink } from '../../src/invocation-sink.js';
import * as registry from '../../src/invocation-sink-registry.js';
import { setLongLivedRuntimeContextFromEnv } from '../../src/long-lived-context.js';

afterEach(async () => {
  mock.restore();
  await registry.closeSink();
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  setLongLivedRuntimeContextFromEnv(process.env);
});

test('returns empty and registers no tools when no long-lived identity is available', async () => {
  setLongLivedRuntimeContextFromEnv({});
  const server = { registerTool: mock(() => {}) } as any;
  const daemon = { getFederationTools: mock(async () => ({ tools: [] })) } as any;
  const result = await registerFederatedTools({ server, daemon });
  expect(result).toEqual({ registered: [], skipped: [] });
  expect(server.registerTool).not.toHaveBeenCalled();
});

test('bootstraps federated tools from daemon and registers one handler per tool', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = { registerTool: mock(() => {}) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({
      tools: [
        { name: 'ha.state_get', description: 'get state' },
        { name: 'ha.state_set', inputSchema: { type: 'object' } },
      ],
    })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const result = await registerFederatedTools({ server, daemon });
  expect(result.registered).toEqual([
    { name: 'ha.state_get', description: 'get state' },
    { name: 'ha.state_set', inputSchema: { type: 'object' } },
  ]);
  expect(result.skipped).toEqual([]);
  expect(server.registerTool).toHaveBeenCalledTimes(2);
});

test('env allowlist filters federated tools before registration', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = { registerTool: mock(() => {}) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({
      tools: [
        { name: 'ha.ha_get_state', description: 'get state' },
        { name: 'ha.ha_call_service', description: 'call service' },
      ],
    })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const result = await registerFederatedTools({ server, daemon, envAllowlist: new Set(['ha.ha_get_state']) });
  expect(result.registered).toEqual([
    { name: 'ha.ha_get_state', description: 'get state' },
  ]);
  expect(result.skipped).toEqual([]);
  expect(server.registerTool).toHaveBeenCalledTimes(1);
});

test('env allowlist accepts canonical federation tool ids', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = { registerTool: mock(() => {}) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({
      tools: [
        { name: 'ha.ha_get_state', description: 'state' },
        { name: 'ha.ha_call_service', description: 'service' },
      ],
    })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const result = await registerFederatedTools({
    server,
    daemon,
    envAllowlist: new Set(['ha.ha_get_state', 'ha.ha_call_service']),
  });
  expect(result.registered.map((t) => t.name)).toEqual(['ha.ha_get_state', 'ha.ha_call_service']);
  expect(server.registerTool).toHaveBeenCalledTimes(2);
});

test('virtual tool handler posts to daemon and returns executed result verbatim', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  let handler: ((args: unknown) => Promise<unknown>) | null = null;
  const server = { registerTool: mock((_name: string, _desc: unknown, fn: unknown) => { handler = fn as any; }) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.state_get' }] })),
    mcpCall: mock(async (req: any) => {
      expect(req).toEqual({
        agent_id: 'agent-1',
        tick_id: 'tick-1',
        tool: 'ha:state_get',
        args: { entity_id: 'light.kitchen' },
      });
      return { action_status: 'executed', result: { ok: true } };
    }),
  } as any;
  await registerFederatedTools({ server, daemon });
  expect(await handler!({ entity_id: 'light.kitchen' })).toEqual({ ok: true });
});

test('virtual tool handler canonicalizes dotted federation tool names before daemon calls', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  let handler: ((args: unknown) => Promise<unknown>) | null = null;
  const server = { registerTool: mock((_name: string, _desc: unknown, fn: unknown) => { handler = fn as any; }) } as any;
  const mcpCall = mock(async (req: any) => {
    expect(req).toEqual({
      agent_id: 'agent-1',
      tick_id: 'tick-1',
      tool: 'ha:ha_get_state',
      args: { entity_id: 'light.kitchen' },
    });
    return { action_status: 'executed', result: { ok: true } };
  });
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.ha_get_state' }] })),
    mcpCall,
  } as any;
  await registerFederatedTools({ server, daemon });
  expect(await handler!({ entity_id: 'light.kitchen' })).toEqual({ ok: true });
  expect(mcpCall).toHaveBeenCalledTimes(1);
});

test('queued results are normalized into text envelopes', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  let handler: ((args: unknown) => Promise<unknown>) | null = null;
  const server = { registerTool: mock((_name: string, _desc: unknown, fn: unknown) => { handler = fn as any; }) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.state_get' }] })),
    mcpCall: mock(async () => ({ action_status: 'queued', pending_action_id: 'pa-1' })),
  } as any;
  await registerFederatedTools({ server, daemon });
  expect(await handler!({})).toEqual({
    content: [{
      type: 'text',
      text: JSON.stringify({
        action_status: 'queued',
        pending_action_id: 'pa-1',
      }),
    }],
  });
});

test('rejected and unavailable results are wrapped with isError', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  let handler: ((args: unknown) => Promise<unknown>) | null = null;
  const server = { registerTool: mock((_name: string, _desc: unknown, fn: unknown) => { handler = fn as any; }) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.state_get' }] })),
    mcpCall: mock(async () => ({ action_status: 'rejected', error: 'not_allowed', details: { reason: 'x' } })),
  } as any;
  await registerFederatedTools({ server, daemon });
  expect(await handler!({})).toEqual({
    content: [{
      type: 'text',
      text: JSON.stringify({ action_status: 'rejected', error: 'not_allowed', details: { reason: 'x' } }),
    }],
    isError: true,
  });

  const unavailableDaemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.state_get' }] })),
    mcpCall: mock(async () => { throw new Error('offline'); }),
  } as any;
  handler = null;
  await registerFederatedTools({ server: { registerTool: mock((_name: string, _desc: unknown, fn: unknown) => { handler = fn as any; }) } as any, daemon: unavailableDaemon });
  expect(await handler!({})).toEqual({
    content: [{
      type: 'text',
      text: JSON.stringify({ action_status: 'rejected', error: 'mcp_unavailable', details: 'offline' }),
    }],
    isError: true,
  });
});

test('registers tools on a real McpServer when inputSchema is JSON Schema (regression for buildServer crash)', async () => {
  // Regression: federation/client.ts used to pass `tool.inputSchema` (JSON
  // Schema from upstream hosted MCP servers) straight into `server.registerTool`,
  // which the SDK rejects with "inputSchema must be a Zod schema or raw shape".
  // That throw bubbled out of buildServer (top-level await in bin/penumbra-mcp.ts
  // has no try/catch) and killed the penumbra-mcp subprocess before transport.connect.
  // From the agent's POV the entire MCP server vanished. This test exercises
  // a real McpServer to make sure it doesn't reproduce.
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  const daemon = {
    getFederationTools: mock(async () => ({
      tools: [
        {
          name: 'ha.ha_get_state',
          description: 'get state',
          inputSchema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
        },
        { name: 'ha.ha_call_service' },
      ],
    })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const result = await registerFederatedTools({ server, daemon });
  expect(result.registered.map((t) => t.name)).toEqual(['ha.ha_get_state', 'ha.ha_call_service']);
  expect(result.skipped).toEqual([]);
});

test('preserves tool-call arguments end-to-end on a real McpServer (regression for inputSchema:{} stripping args)', async () => {
  // Regression: registering with `inputSchema: {}` (an empty Zod raw shape)
  // built a STRICT empty object schema, so the SDK silently dropped every
  // unknown key during input validation — including required tool arguments
  // like `entity_id`. Federated tool calls forwarded `{}` to the upstream
  // hosted MCP server regardless of what the agent sent. This test drives
  // the registered tool's stored callback with non-empty args through a
  // real McpServer and asserts the daemon receives them verbatim.
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  const seen: unknown[] = [];
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.ha_get_state' }] })),
    mcpCall: mock(async (req: any) => {
      seen.push(req.args);
      return { action_status: 'executed', result: { ok: true } };
    }),
  } as any;
  await registerFederatedTools({ server, daemon });

  const registry = (server as any)._registeredTools as Record<string, { handler: Function; inputSchema: { parse: (x: unknown) => unknown } }>;
  const entry = registry['ha.ha_get_state'];
  expect(entry).toBeDefined();
  // The SDK runs the registered Zod schema over incoming args before invoking
  // the handler. Replicate that path to assert keys survive validation.
  const validated = entry.inputSchema.parse({ entity_id: 'light.kitchen', brightness: 50 });
  expect(validated).toEqual({ entity_id: 'light.kitchen', brightness: 50 });
  await entry.handler(validated, {} as any);
  expect(seen).toEqual([{ entity_id: 'light.kitchen', brightness: 50 }]);
});

test('forwards extra._meta to daemon.mcpCall', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.ha_get_state' }] })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  await registerFederatedTools({ server, daemon });
  const registry = (server as any)._registeredTools as Record<string, { handler: Function; inputSchema: { parse: (x: unknown) => unknown } }>;
  const entry = registry['ha.ha_get_state'];
  const validated = entry.inputSchema.parse({ entity_id: 'light.kitchen' });
  await entry.handler(validated, { _meta: { origin: 'claude-code', trace: 'abc' } });

  expect(daemon.mcpCall).toHaveBeenCalledTimes(1);
  expect(daemon.mcpCall).toHaveBeenCalledWith({
    agent_id: 'agent-1',
    tick_id: 'tick-1',
    tool: 'ha:ha_get_state',
    args: { entity_id: 'light.kitchen' },
    _meta: { origin: 'claude-code', trace: 'abc' },
  });
});

test('client drops _meta when UTF-8 byte count > 2048 even if .length stays within budget', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.ha_get_state' }] })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  await registerFederatedTools({ server, daemon });

  const registry = (server as any)._registeredTools as Record<string, { handler: Function; inputSchema: { parse: (x: unknown) => unknown } }>;
  const entry = registry['ha.ha_get_state'];
  const validated = entry.inputSchema.parse({ entity_id: 'light.kitchen' });
  await entry.handler(validated, { _meta: { origin: 'claude-code', blob: '😀'.repeat(600) } });

  expect(daemon.mcpCall).toHaveBeenCalledTimes(1);
  expect(daemon.mcpCall).toHaveBeenNthCalledWith(1, {
    agent_id: 'agent-1',
    tick_id: 'tick-1',
    tool: 'ha:ha_get_state',
    args: { entity_id: 'light.kitchen' },
  });
  expect(errorSpy).toHaveBeenCalledTimes(1);
});

test('oversized _meta drops are logged on every occurrence with running total', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.ha_get_state' }] })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  await registerFederatedTools({ server, daemon });

  const registry = (server as any)._registeredTools as Record<string, { handler: Function; inputSchema: { parse: (x: unknown) => unknown } }>;
  const entry = registry['ha.ha_get_state'];
  const validated = entry.inputSchema.parse({ entity_id: 'light.kitchen' });
  await entry.handler(validated, { _meta: { origin: 'claude-code', blob: 'x'.repeat(3000) } });
  await entry.handler(validated, { _meta: { origin: 'claude-code', blob: 'x'.repeat(3000) } });

  expect(daemon.mcpCall).toHaveBeenNthCalledWith(1, {
    agent_id: 'agent-1',
    tick_id: 'tick-1',
    tool: 'ha:ha_get_state',
    args: { entity_id: 'light.kitchen' },
  });
  expect(daemon.mcpCall).toHaveBeenNthCalledWith(2, {
    agent_id: 'agent-1',
    tick_id: 'tick-1',
    tool: 'ha:ha_get_state',
    args: { entity_id: 'light.kitchen' },
  });
  expect(errorSpy).toHaveBeenCalledTimes(2);
  expect(errorSpy.mock.calls[0]?.[0]).toBe('[federation] dropped oversized _meta');
  expect(errorSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ total_drops: expect.any(Number) }));
  expect(errorSpy.mock.calls[1]?.[0]).toBe('[federation] dropped oversized _meta');
  expect(errorSpy.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ total_drops: expect.any(Number) }));
  const firstDropCount = (errorSpy.mock.calls[0]?.[1] as { total_drops?: number } | undefined)?.total_drops;
  const secondDropCount = (errorSpy.mock.calls[1]?.[1] as { total_drops?: number } | undefined)?.total_drops;
  expect(typeof firstDropCount).toBe('number');
  expect(typeof secondDropCount).toBe('number');
  expect(secondDropCount).toBe((firstDropCount as number) + 1);
});

test('omits _meta when extra is missing, _meta is missing, or _meta is not an object', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.ha_get_state' }] })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  await registerFederatedTools({ server, daemon });

  const registry = (server as any)._registeredTools as Record<string, { handler: Function; inputSchema: { parse: (x: unknown) => unknown } }>;
  const entry = registry['ha.ha_get_state'];
  const validated = entry.inputSchema.parse({ entity_id: 'light.kitchen' });

  await entry.handler(validated);
  await entry.handler(validated, {} as any);
  await entry.handler(validated, { _meta: 'x' });
  await entry.handler(validated, { _meta: ['x'] });
  await entry.handler(validated, { _meta: null });

  expect(daemon.mcpCall).toHaveBeenCalledTimes(5);
  for (const call of daemon.mcpCall.mock.calls) {
    expect(call[0]).toEqual({
      agent_id: 'agent-1',
      tick_id: 'tick-1',
      tool: 'ha:ha_get_state',
      args: { entity_id: 'light.kitchen' },
    });
  }
});

test('skips a federated tool whose registration throws without killing the rest', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  let calls = 0;
  const server = {
    registerTool: mock((name: string) => {
      calls += 1;
      if (name === 'ha.bad') throw new Error('boom');
    }),
  } as any;
  const daemon = {
    getFederationTools: mock(async () => ({
      tools: [{ name: 'ha.ok_one' }, { name: 'ha.bad' }, { name: 'ha.ok_two' }],
    })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const result = await registerFederatedTools({ server, daemon });
  expect(calls).toBe(3);
  expect(result.registered.map((t) => t.name)).toEqual(['ha.ok_one', 'ha.ok_two']);
  expect(result.skipped).toEqual([{ name: 'ha.bad', reason: 'boom' }]);
});

test('bootstrap failure returns no federated tools', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = { registerTool: mock(() => {}) } as any;
  const daemon = { getFederationTools: mock(async () => { throw new Error('boom'); }) } as any;
  const result = await registerFederatedTools({ server, daemon });
  expect(result).toEqual({ registered: [], skipped: [] });
  expect(server.registerTool).not.toHaveBeenCalled();
});

test('federated tool invocation writes exactly one log row (single wrap)', async () => {
  process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = '1';
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);

  const stateRoot = mkdtempSync(join(tmpdir(), 'penumbra-mcp-fed-log-state-'));
  const logPath = join(stateRoot, 'penumbra', 'mcp-invocations.jsonl');
  const sink = openInvocationSink(logPath);
  spyOn(registry, 'getSink').mockReturnValue(sink);

  let handler: ((args: unknown, extra: unknown) => Promise<unknown>) | null = null;
  const server = {
    registerTool: mock((_name: string, _schema: unknown, fn: unknown) => {
      handler = fn as any;
    }),
  } as any;
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha.ha_get_state' }] })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;

  try {
    await registerFederatedTools({ server, daemon });
    await handler!({ entity_id: 'light.kitchen' }, { _meta: { origin: 'federation-test' } });
    await sink.close();
    const text = readFileSync(logPath, 'utf8').trim();
    const rows = text.length === 0
      ? []
      : text.split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('ha.ha_get_state');
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
