import { beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { chainsStartRoute } from '../../src/routes/chains.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

// strict-mode env can leak from a live maestro shell; clear it here so test fixtures stay deterministic
beforeAll(() => { delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID; });

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/chains-task-class-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-12T00:00:00Z'),
    uuid: () => `id-${++n}`,
    agentRegistry: ['planner'],
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
}

test('POST /chains/start accepts missing task_class for legacy callers', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }),
  }), services);

  expect(res.status).toBe(200);
});

test.each(['BOUNDARY', 'STANDARD', 'TRIVIAL'] as const)(
  'POST /chains/start forwards task_class=%s',
  async (task_class) => {
    const services = tempServices();
    const res = await chainsStartRoute(new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ initial_agent: 'planner', message: 'hi', task_class }),
    }), services);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_class).toBe(task_class);
  },
);

test('POST /chains/start rejects malformed task_class', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', task_class: 'NOT_A_CLASS' }),
  }), services);

  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('validation_error');
  expect(JSON.stringify(body.error.field_errors)).toContain('task_class');
});
