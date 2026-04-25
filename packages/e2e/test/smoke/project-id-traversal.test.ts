import { expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  isError?: boolean;
}

test('memory.observe rejects traversal project_id and writes nothing outside the sandbox', async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  });
  await client.notify('notifications/initialized');

  // The MCP server validates project_id at the handler boundary and returns
  // an isError:true tool result (per MCP spec) rather than a JSON-RPC error.
  // Both forms are valid rejections at the protocol layer — assert isError.
  const observeResult = await client.request('tools/call', {
    name: 'memory.observe',
    arguments: {
      ts: new Date().toISOString(),
      source: 'mcp',
      source_detail: 'e2e-traversal',
      session_id: 's-evil',
      event_type: 'agent-prompt',
      lane: 'local',
      project_id: '../../etc/cron.d',
      payload_json: { prompt: 'x' },
      payload_summary: 'x',
    },
  }) as CallToolResult;
  expect(observeResult.isError).toBe(true);

  // Trigger a session.end to ensure no rollup writer fires for the rejected
  // observation. Even if it did, the assertion below proves nothing escaped
  // the sandbox.
  await client.request('tools/call', {
    name: 'session.end',
    arguments: { session_id: 's-evil' },
  }).catch(() => { /* may also error; don't care */ });

  // No file should exist at the resolved traversal target.
  expect(existsSync(join(sb.dir, 'context', '..', '..', 'etc', 'cron.d'))).toBe(false);
  await client.close();
}, 30_000);
