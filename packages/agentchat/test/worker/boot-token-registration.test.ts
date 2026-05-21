import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PenumbraClient } from '../../src/penumbra-client.js';
import { runWorkerBoot } from '../../src/worker-boot.js';

function makeClient(fetchImpl: typeof fetch): { client: PenumbraClient; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pen-boot-reg-'));
  writeFileSync(join(root, 'port'), '1\n');
  writeFileSync(join(root, 'token'), 'shared-tok\n');
  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
  return { client, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('PenumbraClient.registerWorker calls /worker/register with shared bearer and captures worker_token', async () => {
  const captured: { url: string; auth: string | null; body: any }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    const body = await req.json().catch(() => null);
    captured.push({ url, auth: req.headers.get('authorization'), body });
    return Response.json({ worker_token: 'wt-alpha', worker_id: 'W-A' });
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    const result = await client.registerWorker({ worker_id: 'W-A', metadata: { host: 'mac-mini' } });

    expect(result.worker_token).toBe('wt-alpha');
    expect(result.worker_id).toBe('W-A');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('/worker/register');
    expect(captured[0].auth).toBe('Bearer shared-tok');
    expect(captured[0].body.worker_id).toBe('W-A');
    expect(captured[0].body.metadata).toEqual({ host: 'mac-mini' });
    expect(client.getWorkerToken()).toBe('wt-alpha');
  } finally { cleanup(); }
});

test('PenumbraClient.postHeartbeat uses worker_token after registerWorker; was shared-bearer before', async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get('authorization') });
    if (url === '/worker/register') return Response.json({ worker_token: 'wt-hb', worker_id: 'W-A' });
    return Response.json({});
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    // Before register: uses shared bearer
    await client.postHeartbeat('W-A');
    expect(captured[0]).toMatchObject({ url: '/worker/heartbeat', auth: 'Bearer shared-tok' });

    // Register
    await client.registerWorker({ worker_id: 'W-A' });

    // After register: uses worker token
    await client.postHeartbeat('W-A');
    expect(captured[2]).toMatchObject({ url: '/worker/heartbeat', auth: 'Bearer wt-hb' });
  } finally { cleanup(); }
});

test('PenumbraClient.reconcileDispatchOrphans uses worker_token after registerWorker', async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get('authorization') });
    if (url === '/worker/register') return Response.json({ worker_token: 'wt-rec', worker_id: 'W-A' });
    return Response.json({ requeued: 0, exhausted: 0 });
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    // Before register
    await client.reconcileDispatchOrphans('W-A');
    expect(captured[0]).toMatchObject({ url: '/worker/reconcile-orphans', auth: 'Bearer shared-tok' });

    // Register + after
    await client.registerWorker({ worker_id: 'W-A' });
    await client.reconcileDispatchOrphans('W-A');
    expect(captured[2]).toMatchObject({ url: '/worker/reconcile-orphans', auth: 'Bearer wt-rec' });
  } finally { cleanup(); }
});

test('PenumbraClient.claimHandoff + completeHandoff + markFailed use worker_token after registerWorker', async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get('authorization') });
    if (url === '/worker/register') return Response.json({ worker_token: 'wt-handoff', worker_id: 'W-A' });
    if (url.endsWith('/claim')) return Response.json({ handoff_id: 'h-1', status: 'dispatched' });
    if (url.endsWith('/complete')) return Response.json({ handoff_id: 'h-1', status: 'completed' });
    if (url.endsWith('/fail')) return Response.json({ handoff_id: 'h-1', status: 'failed' });
    return Response.json({});
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    await client.registerWorker({ worker_id: 'W-A' });
    await client.claimHandoff('h-1', 'W-A');
    await client.completeHandoff('h-1', 'W-A');
    await client.markFailed('h-1', 'boom', 'W-A');

    const workerCalls = captured.filter((c) => c.url !== '/worker/register');
    expect(workerCalls).toHaveLength(3);
    for (const call of workerCalls) {
      expect(call.auth).toBe('Bearer wt-handoff');
    }
  } finally { cleanup(); }
});

test('Non-worker paths continue to use the shared bearer after registerWorker', async () => {
  const captured: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url).pathname;
    captured.push({ url, auth: req.headers.get('authorization') });
    if (url === '/worker/register') return Response.json({ worker_token: 'wt-nonworker', worker_id: 'W-A' });
    if (url === '/observations') return Response.json({ event_id: 'e-1' });
    return Response.json({});
  }) as any;

  const { client, cleanup } = makeClient(fetchImpl);
  try {
    await client.registerWorker({ worker_id: 'W-A' });
    await client.observe({ ts: '2026-05-21T00:00:00Z', source: 'test', event_type: 'test', lane: 'test', payload_json: {} });

    const observeCall = captured.find((c) => c.url === '/observations');
    expect(observeCall?.auth).toBe('Bearer shared-tok');
  } finally { cleanup(); }
});

describe('runWorkerBoot', () => {
  test('calls registerWorker BEFORE reconcileOrphansAtWorkerBoot steps', async () => {
    const calls: string[] = [];
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const client = {
      registerWorker: async () => {
        calls.push('register');
        return { worker_token: 'wt-x', worker_id: 'W-A' };
      },
      postHeartbeat: async () => { calls.push('heartbeat'); },
      reconcileLongLivedOrphans: async () => { calls.push('long-lived'); return { reconciled: 0 }; },
      reconcileDispatchOrphans: async () => { calls.push('dispatch'); return { requeued: 0, exhausted: 0 }; },
    };

    await runWorkerBoot({ client: client as any, log, workerId: 'W-A' });

    expect(calls[0]).toBe('register');
    const rest = calls.slice(1);
    expect(rest).toContain('heartbeat');
    expect(rest).toContain('long-lived');
    expect(rest).toContain('dispatch');
  });

  test('throws and does NOT call reconcile steps when registerWorker fails', async () => {
    const calls: string[] = [];
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const client = {
      registerWorker: async () => {
        calls.push('register-fail');
        throw new Error('HTTP 503');
      },
      postHeartbeat: async () => { calls.push('heartbeat'); },
      reconcileLongLivedOrphans: async () => { calls.push('long-lived'); return { reconciled: 0 }; },
      reconcileDispatchOrphans: async () => { calls.push('dispatch'); return { requeued: 0, exhausted: 0 }; },
    };

    await expect(
      runWorkerBoot({ client: client as any, log, workerId: 'W-A' }),
    ).rejects.toThrow('HTTP 503');
    expect(calls).toEqual(['register-fail']);
  });
});
