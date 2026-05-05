import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '../../../daemon/src/serve.js';
import { executeWorkflow } from '../../src/exec.js';
import { WorkflowSpecSchema } from '../../src/schema.js';

if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // already loaded
  }
}

function makeWorkflow(output: Record<string, unknown>) {
  return WorkflowSpecSchema.parse({
    name: 'task-wf',
    description: 'file a task',
    triggers: [{ kind: 'manual' }],
    recall: [],
    output: [output],
    run: { kind: 'ts-function' },
  });
}

function makeDaemonFixture() {
  const storageRoot = mkdtempSync(join(tmpdir(), 'task-out-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-05T08:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  services.agentchatConfig = {
    agents: [
      {
        name: 'e2e-stub',
        adapter: 'stub',
        maestro_capable: true,
      },
    ],
  } as any;
  services.watchdog.hasActiveWorker = () => true;

  const token = 'test-token';
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  };

  writeFileSync(join(storageRoot, 'port'), '1\n');
  writeFileSync(join(storageRoot, 'token'), `${token}\n`);

  return {
    services,
    storageRoot,
    fetchImpl,
    stop() {
      try {
        services.supervisor.stopAll();
      } catch {}
      db.close();
      rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

test('task output schema parses minimal config and rejects missing prompt', () => {
  const parsed = WorkflowSpecSchema.parse({
    name: 'task-wf',
    description: 'file a task',
    triggers: [{ kind: 'manual' }],
    recall: [],
    output: [{ kind: 'task', prompt: 'do the thing' }],
    run: { kind: 'ts-function' },
  });
  expect(parsed.output[0]).toEqual({ kind: 'task', prompt: 'do the thing' });

  const missingPrompt = WorkflowSpecSchema.safeParse({
    name: 'task-wf',
    description: 'file a task',
    triggers: [{ kind: 'manual' }],
    recall: [],
    output: [{ kind: 'task' }],
    run: { kind: 'ts-function' },
  });
  expect(missingPrompt.success).toBe(false);
});

test('task output passes through orchestrate kind and eligibility', async () => {
  const fixture = makeDaemonFixture();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = fixture.fetchImpl;

    const result = await executeWorkflow({
      spec: makeWorkflow({
        kind: 'task',
        prompt: 'foo',
        eligibility: { allow_agents: ['e2e-stub'] },
        kind: 'orchestrate',
      }),
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: fixture.storageRoot,
    });

    expect(result.warnings).toEqual([]);
    const task = fixture.services.db
      .query<
        {
          kind: string;
          created_by_kind: string;
          created_by_id: string;
          eligibility: string;
        },
        []
      >(
        `SELECT kind, created_by_kind, created_by_id, eligibility
         FROM tasks
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get();
    expect(task).not.toBeNull();
    expect(task?.kind).toBe('orchestrate');
    expect(task?.created_by_kind).toBe('workflow');
    expect(task?.created_by_id).toBe('task-wf');
    expect(JSON.parse(task?.eligibility ?? '{}')).toEqual({ allow_agents: ['e2e-stub'] });
  } finally {
    globalThis.fetch = realFetch;
    fixture.stop();
  }
});

test('task output passes through bounds', async () => {
  const fixture = makeDaemonFixture();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = fixture.fetchImpl;

    const result = await executeWorkflow({
      spec: makeWorkflow({
        kind: 'task',
        prompt: 'foo',
        eligibility: { allow_agents: ['e2e-stub'] },
        bounds: {
          wall_clock_ms: 60_000,
          cost_cents: 50,
          max_sub_dispatches: 5,
        },
      }),
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: fixture.storageRoot,
    });

    expect(result.warnings).toEqual([]);
    const task = fixture.services.db
      .query<
        {
          bounds_wall_clock_ms: number | null;
          bounds_cost_cents: number | null;
          bounds_max_sub_dispatches: number | null;
        },
        []
      >(
        `SELECT bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches
         FROM tasks
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get();
    expect(task).not.toBeNull();
    expect(task?.bounds_wall_clock_ms).toBe(60_000);
    expect(task?.bounds_cost_cents).toBe(50);
    expect(task?.bounds_max_sub_dispatches).toBe(5);
  } finally {
    globalThis.fetch = realFetch;
    fixture.stop();
  }
});

test('task output defaults to work when kind is omitted', async () => {
  const fixture = makeDaemonFixture();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = fixture.fetchImpl;

    const result = await executeWorkflow({
      spec: makeWorkflow({
        kind: 'task',
        prompt: 'foo',
      }),
      bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
      storageRoot: fixture.storageRoot,
    });

    expect(result.warnings).toEqual([]);
    const task = fixture.services.db
      .query<{ kind: string }, []>(
        `SELECT kind
         FROM tasks
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get();
    expect(task?.kind).toBe('work');
  } finally {
    globalThis.fetch = realFetch;
    fixture.stop();
  }
});
