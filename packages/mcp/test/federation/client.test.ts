import { afterEach, expect, mock, test } from 'bun:test';
import { registerFederatedTools } from '../../src/federation/client.js';
import { setLongLivedRuntimeContextFromEnv } from '../../src/long-lived-context.js';

afterEach(() => {
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  setLongLivedRuntimeContextFromEnv(process.env);
});

test('returns empty and registers no tools when no long-lived identity is available', async () => {
  setLongLivedRuntimeContextFromEnv({});
  const server = { registerTool: mock(() => {}) } as any;
  const daemon = { getFederationTools: mock(async () => ({ tools: [] })) } as any;
  const tools = await registerFederatedTools({ server, daemon });
  expect(tools).toEqual([]);
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
        { name: 'ha:state_get', description: 'get state' },
        { name: 'ha:state_set', inputSchema: { type: 'object' } },
      ],
    })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const tools = await registerFederatedTools({ server, daemon });
  expect(tools).toEqual([
    { name: 'ha:state_get', description: 'get state' },
    { name: 'ha:state_set', inputSchema: { type: 'object' } },
  ]);
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
        { name: 'ha:ha_get_state', description: 'get state' },
        { name: 'ha:ha_call_service', description: 'call service' },
      ],
    })),
    mcpCall: mock(async () => ({ action_status: 'executed', result: { ok: true } })),
  } as any;
  const tools = await registerFederatedTools({ server, daemon, envAllowlist: new Set(['ha:ha_get_state']) });
  expect(tools).toEqual([
    { name: 'ha:ha_get_state', description: 'get state' },
  ]);
  expect(server.registerTool).toHaveBeenCalledTimes(1);
});

test('virtual tool handler posts to daemon and returns executed result verbatim', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  let handler: ((args: unknown) => Promise<unknown>) | null = null;
  const server = { registerTool: mock((_name: string, _desc: unknown, fn: unknown) => { handler = fn as any; }) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha:state_get' }] })),
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

test('queued results are normalized into text envelopes', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  let handler: ((args: unknown) => Promise<unknown>) | null = null;
  const server = { registerTool: mock((_name: string, _desc: unknown, fn: unknown) => { handler = fn as any; }) } as any;
  const daemon = {
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha:state_get' }] })),
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
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha:state_get' }] })),
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
    getFederationTools: mock(async () => ({ tools: [{ name: 'ha:state_get' }] })),
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

test('bootstrap failure returns no federated tools', async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = 'agent-1';
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = 'tick-1';
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = { registerTool: mock(() => {}) } as any;
  const daemon = { getFederationTools: mock(async () => { throw new Error('boom'); }) } as any;
  const tools = await registerFederatedTools({ server, daemon });
  expect(tools).toEqual([]);
  expect(server.registerTool).not.toHaveBeenCalled();
});
