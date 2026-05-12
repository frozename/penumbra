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
  const root = mkdtempSync(join(tmpdir(), 'memory-verify-route-'));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-12T12:00:00.000Z'),
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

function insertT2(db: Database, memoryId: string, createdAt: string): void {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at,
      last_verified_at, last_verified_by, last_verified_reason, last_verified_session_id,
      obs_type, concepts, severity, file_paths
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      null,
      'u1',
      'fact',
      '[]',
      createdAt,
      createdAt,
      memoryId,
      `body for ${memoryId}`,
      '{}',
      null,
      createdAt,
      createdAt,
      null,
      null,
      null,
      null,
      'feature',
      '[]',
      null,
      '[]',
    ],
  );
}

test('POST /memory/verify stores provenance and search returns it', async () => {
  const daemon = startTestDaemon();
  try {
    const createdAt = new Date('2026-05-12T11:00:00.000Z').toISOString();
    insertT2(daemon.services.db, 'memory-route-1', createdAt);

    const res = await daemon.fetch('/memory/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({
        memory_id: 'memory-route-1',
        by: 'agent-name@worktree',
        reason: 'manual spot check',
        session_id: 'lane-xyz',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      memory_id: 'memory-route-1',
      last_verified_by: 'agent-name@worktree',
      last_verified_reason: 'manual spot check',
      last_verified_session_id: 'lane-xyz',
    });

    const searchRes = await daemon.fetch('/memory/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ query: 'memory-route-1', project_id: null, limit: 5, tiers: ['t2'] }),
    });
    expect(searchRes.status).toBe(200);
    const body = await searchRes.json() as { hits: Array<Record<string, unknown>> };
    expect(body.hits[0]).toMatchObject({
      id: 'memory-route-1',
      last_verified_by: 'agent-name@worktree',
      last_verified_reason: 'manual spot check',
      last_verified_session_id: 'lane-xyz',
    });
  } finally {
    daemon.stop();
  }
});

test('POST /memory/verify rejects invalid by values', async () => {
  const daemon = startTestDaemon();
  try {
    insertT2(daemon.services.db, 'memory-route-2', new Date('2026-05-12T11:00:00.000Z').toISOString());

    const res = await daemon.fetch('/memory/verify', {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({
        memory_id: 'memory-route-2',
        by: '<script>',
      }),
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});
