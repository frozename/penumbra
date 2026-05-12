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

  const root = mkdtempSync(join(tmpdir(), 'lanes-route-'));
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

async function postJson(
  daemon: ReturnType<typeof startTestDaemon>,
  path: string,
  body: unknown,
): Promise<Response> {
  return daemon.fetch(path, {
    method: 'POST',
    headers: authHeaders(daemon.token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

test('open then close then recent returns lane with closed status', async () => {
  const daemon = startTestDaemon();
  try {
    const opened = await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-1',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    expect(opened.status).toBe(200);
    const openBody = await opened.json() as { lane_id: string; ts_opened: string; gate_status: string };
    expect(openBody.lane_id).toBe('lane-1');
    expect(openBody.gate_status).toBe('open');

    const closed = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-1',
      gate_status: 'passed',
      reviewer_handoff: 'rev-1',
    });
    expect(closed.status).toBe(200);
    const closeBody = await closed.json() as { lane_id: string; gate_status: string; ts_closed: string | null };
    expect(closeBody.lane_id).toBe('lane-1');
    expect(closeBody.gate_status).toBe('passed');
    expect(closeBody.ts_closed).toBeTruthy();

    const recent = await daemon.fetch('/lanes/recent', { headers: authHeaders(daemon.token) });
    expect(recent.status).toBe(200);
    const recentBody = await recent.json() as { lanes: Array<{ lane_id: string; gate_status: string; ts_closed: string | null }> };
    expect(recentBody.lanes).toHaveLength(1);
    expect(recentBody.lanes[0]?.lane_id).toBe('lane-1');
    expect(recentBody.lanes[0]?.gate_status).toBe('passed');
    expect(recentBody.lanes[0]?.ts_closed).toBeTruthy();
  } finally {
    daemon.stop();
  }
});

test('duplicate lane_id returns 409', async () => {
  const daemon = startTestDaemon();
  try {
    expect((await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-dup',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    })).status).toBe(200);
    const dup = await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-dup',
      implementer_handoff: 'h-2',
      task_class: 'STANDARD',
    });
    expect(dup.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test('close unknown lane returns 404', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'missing',
      gate_status: 'passed',
    });
    expect(res.status).toBe(404);
  } finally {
    daemon.stop();
  }
});

test('close twice returns 409 on second call', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-2',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    const first = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-2',
      gate_status: 'passed',
    });
    expect(first.status).toBe(200);
    const second = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-2',
      gate_status: 'passed',
    });
    expect(second.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test("close rejects gate_status='open' with 400", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-3',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    const res = await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-3',
      gate_status: 'open',
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test('recent filters by status', async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-open',
      implementer_handoff: 'h-1',
      task_class: 'STANDARD',
    });
    await postJson(daemon, '/lanes/open', {
      lane_id: 'lane-passed',
      implementer_handoff: 'h-2',
      task_class: 'STANDARD',
    });
    await postJson(daemon, '/lanes/close', {
      lane_id: 'lane-passed',
      gate_status: 'passed',
    });

    const res = await daemon.fetch('/lanes/recent?status=passed', { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { lanes: Array<{ lane_id: string }> };
    expect(body.lanes.map((lane) => lane.lane_id)).toEqual(['lane-passed']);
  } finally {
    daemon.stop();
  }
});

test('recent limit is capped at 200', async () => {
  const daemon = startTestDaemon();
  try {
    for (let i = 0; i < 3; i++) {
      await postJson(daemon, '/lanes/open', {
        lane_id: `lane-${i}`,
        implementer_handoff: `h-${i}`,
        task_class: 'STANDARD',
      });
    }

    const res = await daemon.fetch('/lanes/recent?limit=999', { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { lanes: Array<unknown> };
    expect(body.lanes).toHaveLength(3);

    const capped = await daemon.fetch('/lanes/recent?limit=200', { headers: authHeaders(daemon.token) });
    expect(capped.status).toBe(200);
  } finally {
    daemon.stop();
  }
});
