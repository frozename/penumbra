import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../src/penumbra-client.js';

test('observe POSTs /observations with bearer token', async () => {
  let received: { body: any; auth: string | null } | null = null;
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    received = { body: await req.json(), auth: req.headers.get('authorization') };
    return Response.json({ event_id: 'e' });
  }) as any;
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `1\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
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
});

test('createHandoff POSTs /handoffs and returns the new id', async () => {
  const fetchImpl: typeof fetch = (async () => Response.json({ handoff_id: 'h-1', status: 'pending' })) as any;
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `1\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
  const r = await client.createHandoff({
    from: 'claude', to: 'gemini', message: 'go',
    conversation_id: 'c-1', project_id: null, triggered_by_event_id: 'e-1',
  });
  expect(r.handoff_id).toBe('h-1');
  expect(r.status).toBe('pending');
});

function withDaemon(): { client: PenumbraClient; services: Services; stop: () => void; storageRoot: string; fetchImpl: typeof fetch } {
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
  services.agentRegistry = ['planner', 'executor', 'a', 'b', 'claude-mem'];
  services.watchdog.hasActiveWorker = () => true;
  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return handler(req);
  }) as any;
  writeFileSync(join(dir, 'port'), '1');
  writeFileSync(join(dir, 'token'), 'tok');
  return {
    client: new PenumbraClient({ storageRoot: dir, fetch: fetchImpl }),
    services,
    storageRoot: dir,
    fetchImpl,
    stop() { try { services.supervisor.stopAll(); } catch {} db.close(); rmSync(dir, { recursive: true, force: true }); },
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
    const claim = await client.claimHandoff(start.handoff_id, 'w1');
    expect(claim.status).toBe('dispatched');
    await expect(client.claimHandoff(start.handoff_id, 'w2')).rejects.toThrow(/409|conflict/i);
  } finally { stop(); }
});

test('PenumbraClient.completeHandoff flips dispatched → completed', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    await client.claimHandoff(start.handoff_id, 'w1');
    const res = await client.completeHandoff(start.handoff_id);
    expect(res.status).toBe('completed');
    const row = services.db.query<any, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(start.handoff_id);
    expect(row.status).toBe('completed');
  } finally { stop(); }
});

test('PenumbraClient.markFailed flips dispatched → failed', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    await client.claimHandoff(start.handoff_id, 'w1');
    const res = await client.markFailed(start.handoff_id, 'adapter blew up');
    expect(res.status).toBe('failed');
    const row = services.db.query<any, [string]>(`SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?`).get(start.handoff_id);
    expect(row.status).toBe('failed');
    expect(row.resolution_reason).toBe('adapter blew up');
  } finally { stop(); }
});

test('PenumbraClient.postDispatchEvents posts best-effort event batches', async () => {
  const { client, services, stop } = withDaemon();
  try {
    await client.postDispatchEvents([
      { handoff_id: 'h-events', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
    ]);
    expect(services.dispatchEventLog.listByHandoff('h-events')).toHaveLength(1);
  } finally { stop(); }
});

test('PenumbraClient.listHandoffs(status=approved,dispatched) returns matching rows', async () => {
  const { client, stop } = withDaemon();
  try {
    const a = await client.startChain({ initial_agent: 'planner', message: 'hi 1' });
    const b = await client.startChain({ initial_agent: 'planner', message: 'hi 2' });
    await client.claimHandoff(a.handoff_id, 'w1');
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
  const { stop, storageRoot, fetchImpl } = withDaemon();
  try {
    const oldEnv = process.env.PENUMBRA_STORAGE_ROOT;
    process.env.PENUMBRA_STORAGE_ROOT = '/bogus/path/that/does/not/exist';
    const client = new PenumbraClient({ storageRoot, fetch: fetchImpl });
    const res = await client.observe({
      ts: '2026-04-25T20:00:00Z',
      source: 'mcp', event_type: 'agent-prompt', lane: 'unknown', payload_json: {}, user_id: 'u', machine_id: 'm'
    });
    expect(res.event_id).toBeDefined();
    if (oldEnv === undefined) { delete process.env.PENUMBRA_STORAGE_ROOT; } else { process.env.PENUMBRA_STORAGE_ROOT = oldEnv; }
  } finally { stop(); }
});

test('PenumbraClient auto-discovers a running daemon when ~/.penumbra is empty', async () => {
  const { stop, storageRoot, fetchImpl } = withDaemon();
  try {
    const oldEnv = process.env.PENUMBRA_STORAGE_ROOT;
    process.env.PENUMBRA_STORAGE_ROOT = storageRoot;
    const client = new PenumbraClient({ fetch: fetchImpl });
    const res = await client.observe({
      ts: '2026-04-25T20:00:00Z',
      source: 'mcp', event_type: 'agent-prompt', lane: 'unknown', payload_json: {}, user_id: 'u', machine_id: 'm'
    });
    expect(res.event_id).toBeDefined();
    if (oldEnv === undefined) { delete process.env.PENUMBRA_STORAGE_ROOT; } else { process.env.PENUMBRA_STORAGE_ROOT = oldEnv; }
  } finally { stop(); }
});

test('PenumbraClient.resolve() throws clear error when explicit storageRoot is bogus', async () => {
  const client = new PenumbraClient({ storageRoot: '/path/that/does/not/exist' });
  await expect(client.observe({
    ts: '2026-04-25T20:00:00Z',
    source: 'mcp', event_type: 'agent-prompt', lane: 'unknown', payload_json: {}, user_id: 'u', machine_id: 'm'
  })).rejects.toThrow(/penumbra not running at \/path\/that\/does\/not\/exist \(missing port\/token\)/);
});

test('PenumbraClient.getHandoffStatus reads reliability status', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    await client.claimHandoff(start.handoff_id, 'w1');
    await services.dispatchEventLog.record({
      handoff_id: start.handoff_id,
      source: 'worker',
      kind: 'dispatch.start',
      ts: '2026-05-01T00:00:01.000Z',
    });

    const status = await client.getHandoffStatus(start.handoff_id);

    expect(status.handoff_id).toBe(start.handoff_id);
    expect(status.status).toBe('dispatched');
    expect(status.reliability.status).toBeDefined();
  } finally { stop(); }
});

test('PenumbraClient.getChainResponses reads final responses', async () => {
  const { client, services, stop } = withDaemon();
  try {
    services.t0Writer.write({
      ts: '2026-05-01T00:00:00.000Z',
      ingest_ts: '2026-05-01T00:00:00.000Z',
      event_id: 'ev-client-responses',
      source: 'agentchat',
      source_detail: null,
      event_type: 'agent-response',
      lane: 'cli-subscription',
      session_id: 'conv-client-responses',
      project_id: null,
      user_id: 'agent-a',
      machine_id: 'local',
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: null,
      request_id: null,
      payload_json: { response: 'HELLO' },
      payload_summary: 'HELLO',
    } as any);

    const responses = await client.getChainResponses('conv-client-responses', 'all');

    expect(responses.responses).toEqual([
      expect.objectContaining({ agent: 'agent-a', text: 'HELLO' }),
    ]);
  } finally { stop(); }
});

test('PenumbraClient dispatch and worktree read methods call daemon routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pen-client-read-'));
  writeFileSync(join(root, 'port'), '1\n');
  writeFileSync(join(root, 'token'), 'tk\n');
  try {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      seen.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
      if (req.url.includes('/dispatch/events')) return Response.json({ events: [{ kind: 'dispatch.start' }] });
      if (req.url.includes('/dispatch/audit')) return Response.json({ report: { status: 'complete', trustworthy: true } });
      if (req.url.includes('/worktrees/')) return Response.json({ worktree: { path: '/tmp/wt' }, diff_against_main: '', branch_log: '' });
      return Response.json({});
    }) as any;
    const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });

    await client.getDispatchTimeline('h-1');
    await client.dispatchAudit('h-1');
    await client.inspectWorktree('h-1');

    expect(seen).toEqual([
      'GET /dispatch/events?handoff_id=h-1',
      'GET /dispatch/audit?handoff_id=h-1',
      'GET /worktrees/h-1',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('PenumbraClient permission methods', () => {
  test('createPermission posts the body and returns the response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pen-perm-'));
    writeFileSync(join(root, 'port'), '1\n');
    writeFileSync(join(root, 'token'), 'tk\n');
    try {
      let capturedUrl = '';
      let capturedMethod = '';
      const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        capturedUrl = req.url;
        capturedMethod = req.method;
        return Response.json({ permission_id: 'p-1', status: 'pending', ttl_at: 't' });
      }) as any;
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
      const out = await client.createPermission({
        permission_id: 'p-1', parent_handoff_id: 'h-1', conversation_id: 'c',
        agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 60,
      });
      expect(out).toEqual({ permission_id: 'p-1', status: 'pending', ttl_at: 't' });
      expect(capturedUrl).toBe('http://127.0.0.1:1/permissions');
      expect(capturedMethod).toBe('POST');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('getPermission fetches and returns the row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pen-perm-'));
    writeFileSync(join(root, 'port'), '1\n');
    writeFileSync(join(root, 'token'), 'tk\n');
    try {
      let capturedUrl = '';
      const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        capturedUrl = req.url;
        return Response.json({ permission: { permission_id: 'p-1', status: 'pending', parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input_json: '{}', remember_scope: null, decision_reason: null, decided_by: null, ttl_at: 't', created_at: 't', decided_at: null } });
      }) as any;
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
      const out = await client.getPermission('p-1');
      expect(out.permission.permission_id).toBe('p-1');
      expect(capturedUrl).toBe('http://127.0.0.1:1/permissions/p-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('decidePermission posts decide body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pen-perm-'));
    writeFileSync(join(root, 'port'), '1\n');
    writeFileSync(join(root, 'token'), 'tk\n');
    try {
      let capturedUrl = '';
      let capturedMethod = '';
      const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        capturedUrl = req.url;
        capturedMethod = req.method;
        return Response.json({ permission_id: 'p-1', status: 'approved', decided_at: 't' });
      }) as any;
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
      const out = await client.decidePermission('p-1', { decision: 'approve', remember: 'this_dispatch' });
      expect(out.status).toBe('approved');
      expect(capturedUrl).toBe('http://127.0.0.1:1/permissions/p-1/decide');
      expect(capturedMethod).toBe('POST');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('listPermissions composes status + conversation_id + parent_handoff_id query params', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pen-perm-'));
    writeFileSync(join(root, 'port'), '1\n');
    writeFileSync(join(root, 'token'), 'tk\n');
    try {
      let capturedUrl = '';
      const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        capturedUrl = req.url;
        return Response.json({ permissions: [] });
      }) as any;
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
      await client.listPermissions({ status: 'pending,approved', conversation_id: 'c-1', parent_handoff_id: 'h-1' });
      expect(capturedUrl).toContain('/permissions?');
      expect(capturedUrl).toContain('status=pending%2Capproved');
      expect(capturedUrl).toContain('conversation_id=c-1');
      expect(capturedUrl).toContain('parent_handoff_id=h-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('listPermissions with no opts hits /permissions without a query string', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pen-perm-'));
    writeFileSync(join(root, 'port'), '1\n');
    writeFileSync(join(root, 'token'), 'tk\n');
    try {
      let capturedUrl = '';
      const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        capturedUrl = req.url;
        return Response.json({ permissions: [] });
      }) as any;
      const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
      await client.listPermissions();
      expect(capturedUrl).toBe('http://127.0.0.1:1/permissions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
