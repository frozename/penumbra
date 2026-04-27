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

test('penumbra-mcp boots, registers 3 tools, exits 0 on stdin close', async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);

  const initResult = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'penumbra-e2e', version: '0.0.0' },
  }) as { serverInfo?: { name?: string } };
  expect(initResult.serverInfo?.name).toBe('penumbra');

  // The MCP spec requires the client to send the initialized notification
  // before issuing further requests.
  await client.notify('notifications/initialized');

  const toolsResult = await client.request('tools/list', {}) as {
    tools: { name: string }[];
  };
  const names = toolsResult.tools.map((t) => t.name).sort();
  expect(names).toEqual([
    'chain.history',
    'chain.start',
    'handoff.approve',
    'handoff.list_pending',
    'memory.observe',
    'memory.recall',
    'session.end',
  ]);

  await client.close();
  const exitCode = await Promise.race([
    mcp.exited,
    new Promise<number>((r) => setTimeout(() => r(-1), 3000)),
  ]);
  expect(exitCode).toBe(0);
  mcp = null;
}, 30_000);
