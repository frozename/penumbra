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

  const root = mkdtempSync(join(tmpdir(), 'maestro-route-'));
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

test('GET /maestro/sessions/:task_id returns the hydrated record', async () => {
  const daemon = startTestDaemon();
  try {
    daemon.services.db.query(
      `INSERT INTO maestro_sessions (
        task_id, chain_handoff_id, agent_id, started_at,
        wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget,
        cost_consumed_cents, sub_dispatches_consumed, soft_warned_at,
        terminated_at, termination_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'task-1',
      'handoff-1',
      'codex',
      1_746_000_000_000,
      120_000,
      80,
      3,
      12,
      1,
      null,
      null,
      null,
    );

    const res = await daemon.fetch('/maestro/sessions/task-1', {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      task_id: 'task-1',
      chain_handoff_id: 'handoff-1',
      agent_id: 'codex',
      started_at: 1_746_000_000_000,
      wall_clock_budget_ms: 120_000,
      cost_budget_cents: 80,
      sub_dispatch_budget: 3,
      cost_consumed_cents: 12,
      sub_dispatches_consumed: 1,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
  } finally {
    daemon.stop();
  }
});

test('GET /maestro/sessions/:task_id returns 404 for unknown task_id', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await daemon.fetch('/maestro/sessions/unknown-id', {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'maestro session unknown-id not found',
      },
    });
  } finally {
    daemon.stop();
  }
});

test('GET /maestro/sessions/:task_id requires bearer auth', async () => {
  const daemon = startTestDaemon();
  try {
    const missing = await daemon.fetch('/maestro/sessions/task-1');
    expect(missing.status).toBe(401);

    const wrong = await daemon.fetch('/maestro/sessions/task-1', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.status).toBe(401);
  } finally {
    daemon.stop();
  }
});
