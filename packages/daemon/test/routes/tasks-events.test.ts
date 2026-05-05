import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

  const root = mkdtempSync(join(tmpdir(), 'tasks-events-route-'));
  const worktreeRootDir = join(root, 'worktrees');
  const mainRepoDir = join(root, 'main');
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:00:00.000Z'),
    worktreeRootDir,
    mainRepoDir,
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };

  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents: [{ name: 'codex', tags: ['typescript'], tier: 'oc', cost_cents_per_run: 15 }],
  };

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
  return {
    authorization: `Bearer ${token}`,
    ...headers,
  };
}

async function postJson(
  daemon: ReturnType<typeof startTestDaemon>,
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  return daemon.fetch(path, {
    method: 'POST',
    headers: authHeaders(daemon.token, {
      'content-type': 'application/json',
      ...headers,
    }),
    body: JSON.stringify(body),
  });
}

async function fileTask(daemon: ReturnType<typeof startTestDaemon>, body: Record<string, unknown> = {}): Promise<string> {
  const res = await postJson(daemon, '/tasks', {
    prompt: 'implement route',
    created_by_kind: 'human',
    created_by_id: 'cli',
    ...body,
  });
  expect(res.status).toBe(201);
  const json = await res.json() as { task_id: string };
  return json.task_id;
}

async function readSseEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1000): Promise<any[]> {
  const reader = stream.getReader();
  const events: any[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
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
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
    }
  }
  reader.releaseLock();
  return events;
}

test('GET /tasks/events streams live filed events', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/tasks/events', {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const taskId = await fileTask(daemon);
    const events = await readSseEvents(res.body!, 1, 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task_id: taskId,
      kind: 'filed',
      actor: 'cli',
    });
    expect(typeof events[0].at).toBe('number');
  } finally {
    daemon.stop();
  }
});

test('GET /tasks/events replays rows from since', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const row = daemon.services.db
      .query<{ at: number }, [string]>(
        `SELECT at FROM task_events WHERE task_id = ? AND kind = 'filed' ORDER BY id ASC LIMIT 1`,
      )
      .get(taskId);
    expect(row).toBeTruthy();

    const res = await daemon.fetch(`/tasks/events?since=${(row?.at ?? 0) - 1}`, {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    const events = await readSseEvents(res.body!, 1, 1000);
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe(taskId);
    expect(events[0].kind).toBe('filed');
  } finally {
    daemon.stop();
  }
});

test('GET /tasks/events?kind=leased filters out non-leased events', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/tasks/events?kind=leased', {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);

    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);

    const events = await readSseEvents(res.body!, 1, 1000);
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe(taskId);
    expect(events[0].kind).toBe('leased');
    expect(events[0].actor).toBe('codex');
  } finally {
    daemon.stop();
  }
});

test('GET /tasks/events fans out the same event to multiple subscribers', async () => {
  const daemon = startTestDaemon();
  try {
    const r1 = await daemon.fetch('/tasks/events', {
      headers: authHeaders(daemon.token),
    });
    const r2 = await daemon.fetch('/tasks/events', {
      headers: authHeaders(daemon.token),
    });

    const taskId = await fileTask(daemon);
    const [a, b] = await Promise.all([
      readSseEvents(r1.body!, 1, 1000),
      readSseEvents(r2.body!, 1, 1000),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].task_id).toBe(taskId);
    expect(b[0].task_id).toBe(taskId);
  } finally {
    daemon.stop();
  }
});
