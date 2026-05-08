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

  const root = mkdtempSync(join(tmpdir(), 'chains-list-'));
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

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function seedConversation(services: Services, opts: {
  conversation_id: string;
  ts: string;
  status: 'approved' | 'completed' | 'dispatched' | 'failed';
  project_id?: string | null;
  to_agent?: string;
  to_role?: string | null;
}): void {
  const handoff_id = `h-${opts.conversation_id}`;
  services.handoffWriter.createApproved({
    handoff_id,
    ts: opts.ts,
    project_id: opts.project_id ?? null,
    conversation_id: opts.conversation_id,
    from: 'user',
    to: opts.to_agent ?? 'codex',
    to_role: opts.to_role ?? null,
    message: 'go',
    triggered_by_event_id: `e-${opts.conversation_id}`,
    resolved_by: 'test',
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    branch_base: null,
  });
  if (opts.status === 'dispatched' || opts.status === 'completed') {
    services.handoffWriter.claimDispatch(handoff_id, 'worker-1');
  }
  if (opts.status === 'completed') {
    services.handoffWriter.markCompleted(handoff_id, { ts: opts.ts });
  } else if (opts.status === 'failed') {
    services.handoffWriter.markFailed(handoff_id, { reason: 'test', ts: opts.ts, resolved_by: 'test' });
  }
}

test('GET /chains returns empty array when no chains exist', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/chains', { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { chains: unknown[]; limit: number; offset: number };
    expect(body.chains).toEqual([]);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
  } finally {
    daemon.stop();
  }
});

test('GET /chains returns one summary per conversation_id, latest first', async () => {
  const daemon = startTestDaemon();
  try {
    seedConversation(daemon.services, { conversation_id: 'c-old', ts: '2026-04-22T10:00:00.000Z', status: 'completed' });
    seedConversation(daemon.services, { conversation_id: 'c-new', ts: '2026-04-23T11:00:00.000Z', status: 'approved' });

    const res = await daemon.fetch('/chains', { headers: authHeaders(daemon.token) });
    const body = await res.json() as { chains: Array<{ conversation_id: string; latest_status: string }> };
    expect(body.chains.map((c) => c.conversation_id)).toEqual(['c-new', 'c-old']);
    expect(body.chains[0]?.latest_status).toBe('approved');
    expect(body.chains[1]?.latest_status).toBe('completed');
  } finally {
    daemon.stop();
  }
});

test('?status filters by latest_status', async () => {
  const daemon = startTestDaemon();
  try {
    seedConversation(daemon.services, { conversation_id: 'c-1', ts: '2026-04-22T10:00:00.000Z', status: 'completed' });
    seedConversation(daemon.services, { conversation_id: 'c-2', ts: '2026-04-23T11:00:00.000Z', status: 'approved' });

    const res = await daemon.fetch('/chains?status=completed', { headers: authHeaders(daemon.token) });
    const body = await res.json() as { chains: Array<{ conversation_id: string; latest_status: string }> };
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0]?.conversation_id).toBe('c-1');
  } finally {
    daemon.stop();
  }
});

test('?limit and ?offset paginate results', async () => {
  const daemon = startTestDaemon();
  try {
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.UTC(2026, 3, 22, 10 + i, 0, 0)).toISOString();
      seedConversation(daemon.services, { conversation_id: `c-${i}`, ts, status: 'completed' });
    }
    const page1 = await (await daemon.fetch('/chains?limit=2', { headers: authHeaders(daemon.token) })).json() as { chains: Array<{ conversation_id: string }>; limit: number; offset: number };
    expect(page1.limit).toBe(2);
    expect(page1.chains.map((c) => c.conversation_id)).toEqual(['c-4', 'c-3']);

    const page2 = await (await daemon.fetch('/chains?limit=2&offset=2', { headers: authHeaders(daemon.token) })).json() as { chains: Array<{ conversation_id: string }>; offset: number };
    expect(page2.offset).toBe(2);
    expect(page2.chains.map((c) => c.conversation_id)).toEqual(['c-2', 'c-1']);
  } finally {
    daemon.stop();
  }
});

test('limit > 500 rejected with 400', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/chains?limit=999', { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  } finally {
    daemon.stop();
  }
});

test('unknown status rejected with 400', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/chains?status=bogus', { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

