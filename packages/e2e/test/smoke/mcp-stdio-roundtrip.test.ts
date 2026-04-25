import { expect, test, beforeEach, afterEach } from 'bun:test';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
  captureOutput,
  killGracefully,
  drainOutput,
  type BunSubprocess,
} from '../helpers/spawn-bin.js';
import { JsonRpcStdioClient } from '../helpers/jsonrpc-stdio.js';

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;

beforeEach(async () => {
  sb = makeSandbox();
  expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);
  daemon = spawnPenumbra(['start'], sb.dir);
  drainOutput(daemon);  // prevent stdout buffer deadlock
  await waitForPortFile(sb.dir, 5000);
});

afterEach(async () => {
  if (mcp) { await killGracefully(mcp); mcp = null; }
  if (daemon) {
    await captureOutput(spawnPenumbra(['stop'], sb.dir));
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

interface CallToolResult {
  content: { type: string; text: string }[];
}

test('observe → session.end → recall round-trip via stdio MCP', async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);

  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');

  await client.request('tools/call', {
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-stdio',
      session_id: 's-stdio',
      event_type: 'agent-prompt',
      lane: 'local',
      project_id: 'proj-stdio',
      payload_json: { prompt: 'refactor auth middleware' },
      payload_summary: 'refactor auth middleware',
    },
  });

  await client.request('tools/call', {
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-stdio',
      session_id: 's-stdio',
      event_type: 'agent-response',
      lane: 'local',
      project_id: 'proj-stdio',
      payload_json: { response: 'updated src/auth.ts' },
      payload_summary: 'updated src/auth.ts',
    },
  });

  await client.request('tools/call', {
    name: 'session.end',
    arguments: { session_id: 's-stdio' },
  });

  const recall = await client.request('tools/call', {
    name: 'memory.recall',
    arguments: { query: 'refactor auth middleware', project_id: 'proj-stdio', limit: 5 },
  }) as CallToolResult;
  const text = recall.content[0]!.text;
  const payload = JSON.parse(text) as { results: { tier: string; body: string }[] };
  expect(payload.results.length).toBe(1);
  expect(payload.results[0]!.tier).toBe('t1');
  expect(payload.results[0]!.body).toContain('refactor');

  await client.close();
}, 45_000);
