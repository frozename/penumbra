import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { serve } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../src/penumbra-client.js';

test('observe POSTs /observations with bearer token', async () => {
  let received: { body: any; auth: string | null } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { body: await req.json(), auth: req.headers.get('authorization') };
      return Response.json({ event_id: 'e' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root });
  await client.observe({
    ts: '2026-04-25T20:00:00Z',
    source: 'mcp',
    event_type: 'agent-prompt',
    lane: 'unknown',
    payload_json: {},
    user_id: 'u', machine_id: 'm',
  });
  expect(received).not.toBeNull();
  expect(received!.auth).toBe('Bearer tk');
  server.stop(true);
});

test('createHandoff POSTs /handoffs and returns the new id', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ handoff_id: 'h-1', status: 'pending' }),
  });
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root });
  const r = await client.createHandoff({
    from: 'claude', to: 'gemini', message: 'go',
    conversation_id: 'c-1', project_id: null, triggered_by_event_id: 'e-1',
  });
  expect(r.handoff_id).toBe('h-1');
  expect(r.status).toBe('pending');
  server.stop(true);
});

function withDaemon(): { client: PenumbraClient; services: Services; stop: () => void; storageRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {}, input: {}, storageRoot: dir, db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  const handle = serve({ services, token: 'tok', port: 0 });
  writeFileSync(join(dir, 'port'), String(handle.port));
  writeFileSync(join(dir, 'token'), 'tok');
  return {
    client: new PenumbraClient({ storageRoot: dir }),
    services,
    storageRoot: dir,
    stop() { handle.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('PenumbraClient.startChain calls /chains/start', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const res = await client.startChain({ initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all' });
    expect(typeof res.conversation_id).toBe('string');
    expect(typeof res.handoff_id).toBe('string');
    const row = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(res.handoff_id);
    expect(row.status).toBe('approved');
  } finally { stop(); }
});

test('PenumbraClient.claimHandoff returns 200 on success and rejects on conflict', async () => {
  const { client, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    const claim = await client.claimHandoff(start.handoff_id);
    expect(claim.status).toBe('dispatched');
    await expect(client.claimHandoff(start.handoff_id)).rejects.toThrow(/409|conflict/i);
  } finally { stop(); }
});

test('PenumbraClient.completeHandoff flips dispatched → completed', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    await client.claimHandoff(start.handoff_id);
    const res = await client.completeHandoff(start.handoff_id);
    expect(res.status).toBe('completed');
    const row = services.db.query<any, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(start.handoff_id);
    expect(row.status).toBe('completed');
  } finally { stop(); }
});

test('PenumbraClient.listHandoffs(status=approved,dispatched) returns matching rows', async () => {
  const { client, stop } = withDaemon();
  try {
    const a = await client.startChain({ initial_agent: 'planner', message: 'hi 1' });
    const b = await client.startChain({ initial_agent: 'planner', message: 'hi 2' });
    await client.claimHandoff(a.handoff_id);
    const r = await client.listHandoffs({ statuses: ['approved', 'dispatched'] });
    const ids = r.handoffs.map((h: any) => h.handoff_id).sort();
    expect(ids).toEqual([a.handoff_id, b.handoff_id].sort());
  } finally { stop(); }
});

test('PenumbraClient.subscribeHandoffEvents yields each approved handoff', async () => {
  const { client, stop } = withDaemon();
  try {
    const it = client.subscribeHandoffEvents();
    const first = it[Symbol.asyncIterator]().next();
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    const event = await Promise.race([
      first,
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 1000)),
    ]);
    expect((event as any).value).toBeDefined();
    expect((event as any).value.handoff_id).toBe(start.handoff_id);
    await it.return?.();
  } finally { stop(); }
});

test('PenumbraClient prefers an explicit storageRoot over autodiscovery', async () => {
  const { stop, storageRoot } = withDaemon();
  try {
    const oldEnv = process.env.PENUMBRA_STORAGE_ROOT;
    process.env.PENUMBRA_STORAGE_ROOT = '/bogus/path/that/does/not/exist';
    const client = new PenumbraClient({ storageRoot });
    const res = await client.observe({
      ts: '2026-04-25T20:00:00Z',
      source: 'mcp', event_type: 'agent-prompt', lane: 'unknown', payload_json: {}, user_id: 'u', machine_id: 'm'
    });
    expect(res.event_id).toBeDefined();
    if (oldEnv === undefined) { delete process.env.PENUMBRA_STORAGE_ROOT; } else { process.env.PENUMBRA_STORAGE_ROOT = oldEnv; }
  } finally { stop(); }
});

test('PenumbraClient auto-discovers a running daemon when ~/.penumbra is empty', async () => {
  const { stop, storageRoot } = withDaemon();
  try {
    const oldEnv = process.env.PENUMBRA_STORAGE_ROOT;
    process.env.PENUMBRA_STORAGE_ROOT = storageRoot;
    const client = new PenumbraClient({});
    const res = await client.observe({
      ts: '2026-04-25T20:00:00Z',
      source: 'mcp', event_type: 'agent-prompt', lane: 'unknown', payload_json: {}, user_id: 'u', machine_id: 'm'
    });
    expect(res.event_id).toBeDefined();
    if (oldEnv === undefined) { delete process.env.PENUMBRA_STORAGE_ROOT; } else { process.env.PENUMBRA_STORAGE_ROOT = oldEnv; }
  } finally { stop(); }
});
