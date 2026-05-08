import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '../../src/serve.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  stop: () => void;
} {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), 'dispatch-events-stream-'));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:00:00.000Z'),
  });

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token });

  return {
    fetch: (path, init) => handler(new Request(`http://x${path}`, init)),
    services,
    token,
    stop: () => {
      try { services.supervisor.stopAll(); } catch {}
      try { db.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return { authorization: `Bearer ${token}`, ...headers };
}

async function readSseFrames(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1000): Promise<{ data: any[]; comments: string[] }> {
  const reader = stream.getReader();
  const data: any[] = [];
  const comments: string[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (data.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))),
    ]);
    if (done) break;
    if (!value) continue;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const trimmed = frame.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(':')) {
        comments.push(trimmed);
        continue;
      }
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) data.push(JSON.parse(dataLine.slice(6)));
    }
  }
  reader.releaseLock();
  return { data, comments };
}

test('GET /dispatch/events/stream returns 200 + text/event-stream', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/dispatch/events/stream', {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    daemon.services.dispatchEventLog.record({
      handoff_id: 'h-bootstrap',
      source: 'daemon',
      kind: 'claim',
      ts: '2026-04-23T12:00:00.000Z',
    });
    const { data, comments } = await readSseFrames(res.body!, 1, 1000);
    expect(data).toHaveLength(1);
    // Bootstrap frame `: ok` is sent before live events.
    expect(comments.some((c) => c.includes(': ok'))).toBe(true);
  } finally {
    daemon.stop();
  }
});

test('streams a live event published via dispatchEventLog.record', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/dispatch/events/stream', {
      headers: authHeaders(daemon.token),
    });

    daemon.services.dispatchEventLog.record({
      handoff_id: 'h-1',
      worker_id: 'w-1',
      source: 'worker',
      kind: 'dispatch.start',
      ts: '2026-04-23T12:00:00.000Z',
      meta: { foo: 'bar' },
    });

    const { data } = await readSseFrames(res.body!, 1, 1000);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      handoff_id: 'h-1',
      worker_id: 'w-1',
      source: 'worker',
      kind: 'dispatch.start',
      ts: '2026-04-23T12:00:00.000Z',
      meta: { foo: 'bar' },
    });
  } finally {
    daemon.stop();
  }
});

test('replays rows from `since` (unix ms) before live events', async () => {
  const daemon = startTestDaemon();
  try {
    daemon.services.dispatchEventLog.recordBatch([
      {
        handoff_id: 'h-1',
        source: 'daemon',
        kind: 'dispatch.start',
        ts: '2026-04-23T12:00:00.000Z',
      },
      {
        handoff_id: 'h-2',
        source: 'worker',
        kind: 'heartbeat.received',
        ts: '2026-04-23T12:00:01.000Z',
      },
    ]);

    const since = new Date('2026-04-23T11:59:59.000Z').getTime();
    const res = await daemon.fetch(`/dispatch/events/stream?since=${since}`, {
      headers: authHeaders(daemon.token),
    });

    const { data } = await readSseFrames(res.body!, 2, 1000);
    expect(data.map((e) => e.handoff_id)).toEqual(['h-1', 'h-2']);
  } finally {
    daemon.stop();
  }
});

test('?handoff_id filter rejects non-matching live events', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/dispatch/events/stream?handoff_id=h-target', {
      headers: authHeaders(daemon.token),
    });

    const baseEvent = { source: 'worker' as const, kind: 'dispatch.start' as const, ts: '2026-04-23T12:00:00.000Z' };
    daemon.services.dispatchEventLog.record({ ...baseEvent, handoff_id: 'h-other' });
    daemon.services.dispatchEventLog.record({ ...baseEvent, handoff_id: 'h-target' });

    const { data } = await readSseFrames(res.body!, 1, 1000);
    expect(data).toHaveLength(1);
    expect(data[0].handoff_id).toBe('h-target');
  } finally {
    daemon.stop();
  }
});

test('?source=daemon filters out worker-emitted events', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/dispatch/events/stream?source=daemon', {
      headers: authHeaders(daemon.token),
    });

    daemon.services.dispatchEventLog.record({
      handoff_id: 'h-1', source: 'worker', kind: 'dispatch.start', ts: '2026-04-23T12:00:00.000Z',
    });
    daemon.services.dispatchEventLog.record({
      handoff_id: 'h-1', source: 'daemon', kind: 'claim', ts: '2026-04-23T12:00:01.000Z',
    });

    const { data } = await readSseFrames(res.body!, 1, 1000);
    expect(data).toHaveLength(1);
    expect(data[0].source).toBe('daemon');
    expect(data[0].kind).toBe('claim');
  } finally {
    daemon.stop();
  }
});

test('?kind=dispatch.start,claim filters multi-kind', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/dispatch/events/stream?kind=dispatch.start,claim', {
      headers: authHeaders(daemon.token),
    });

    daemon.services.dispatchEventLog.record({
      handoff_id: 'h-1', source: 'worker', kind: 'dispatch.start', ts: '2026-04-23T12:00:00.000Z',
    });
    daemon.services.dispatchEventLog.record({
      handoff_id: 'h-1', source: 'worker', kind: 'heartbeat.received', ts: '2026-04-23T12:00:01.000Z',
    });
    daemon.services.dispatchEventLog.record({
      handoff_id: 'h-1', source: 'daemon', kind: 'claim', ts: '2026-04-23T12:00:02.000Z',
    });

    const { data } = await readSseFrames(res.body!, 2, 1000);
    expect(data.map((e) => e.kind)).toEqual(['dispatch.start', 'claim']);
  } finally {
    daemon.stop();
  }
});

test('rejects invalid kind with 400', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/dispatch/events/stream?kind=not.a.kind', {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});
