import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSqliteVec, migrate, PlanWriter, TaskWriter, TaskEventBus, OrchestrateAgentNotMaestroCapable } from '@penumbra/core';
import { createPlanRuntimeSweeper } from '../../src/sweepers/plan-runtime.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function makeDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makePlanFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'plan-runtime-'));
  const path = join(root, name);
  writeFileSync(path, '# plan\n', 'utf8');
  return path;
}

function fakeParser(header: any, tasks: any[]) {
  return async (_path: string) => ({ header, tasks, errors: [] });
}

function makeTaskWriter(db: Database): TaskWriter {
  return new TaskWriter(db, {
    bus: new TaskEventBus(),
    resolveAgent: (name: string) => ({ name, maestro_capable: true }),
  });
}

function makeThrowingTaskWriter(db: Database, error: Error): TaskWriter {
  const writer = makeTaskWriter(db);
  return {
    ...writer,
    file: () => {
      throw error;
    },
  } as TaskWriter;
}

const baseTask = {
  files: ['x.ts'],
  file_scope: 'new',
  parallel_with: [],
  preferred_agent: 'codex-acp-fast',
  fallback_agent: 'claude-acp-sonnet',
  task_size: 'small',
  risk_class: 'paste-ready',
};

test('single root fires once + idempotent across ticks', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }] });

  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{ ...baseTask, id: '1.1', depends_on: [] }]),
  });

  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual(['1.1']);
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual([]);
});

test('chained 1.1 → 1.2', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [
    { task_meta_id: '1.1', project_id: 'penumbra' },
    { task_meta_id: '1.2', project_id: 'penumbra' },
  ]});
  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [] },
      { ...baseTask, id: '1.2', depends_on: ['1.1'] },
    ]),
  });
  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual(['1.1']);
  plans.markTaskStatus('p1', '1.1', 'completed');
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual(['1.2']);
});

test('cross-project deps', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [
    { task_meta_id: '1.1', project_id: 'penumbra' },
    { task_meta_id: '1.2', project_id: 'sirius' },
  ]});
  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [], project: 'penumbra' },
      { ...baseTask, id: '1.2', depends_on: ['penumbra/1.1'], project: 'sirius' },
    ]),
  });
  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual(['1.1']);
  plans.markTaskStatus('p1', '1.1', 'completed');
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual(['1.2']);
  const sirius = plans.getTasks('p1').find((t) => t.task_meta_id === '1.2');
  expect(sirius?.project_id).toBe('sirius');
});

test('failure flips plan to failed and stops firing pending', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [
    { task_meta_id: '1.1', project_id: 'penumbra' },
    { task_meta_id: '1.2', project_id: 'penumbra' },
  ]});
  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [] },
      { ...baseTask, id: '1.2', depends_on: [] },
    ]),
  });
  await sweeper.tick();
  plans.markTaskStatus('p1', '1.1', 'failed');
  await sweeper.tick();
  expect(plans.getPlan('p1')?.status).toBe('failed');
});

test('cancelled plan → pending skipped', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }] });
  plans.markPlanStatus('p1', 'cancelled');
  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{ ...baseTask, id: '1.1', depends_on: [] }]),
  });
  const r = await sweeper.tick();
  expect(r.fired).toEqual([]);
});

test('completion flips plan to completed', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeTaskWriter(db);
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }] });
  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{ ...baseTask, id: '1.1', depends_on: [] }]),
  });
  await sweeper.tick();
  plans.markTaskStatus('p1', '1.1', 'completed');
  await sweeper.tick();
  expect(plans.getPlan('p1')?.status).toBe('completed');
});

test('transient taskWriter.file failure → row fails and does not retry', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const realTaskWriter = makeTaskWriter(db);
  let callCount = 0;
  const flakyTaskWriter = {
    ...realTaskWriter,
    file: (input: any) => {
      callCount += 1;
      if (callCount === 1) throw new Error('transient');
      return realTaskWriter.file(input);
    },
  };
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }] });
  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter: flakyTaskWriter as any,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{ ...baseTask, id: '1.1', depends_on: [] }]),
  });
  const r1 = await sweeper.tick();
  expect(r1.fired).toEqual([]);
  expect(plans.getTasks('p1')[0]?.status).toBe('failed');
  const r2 = await sweeper.tick();
  expect(r2.fired).toEqual([]);
});

test('unknown agent failure marks task failed and logs not found', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const logs: Array<{ msg: string; meta?: any }> = [];
  const taskWriter = makeThrowingTaskWriter(db, new OrchestrateAgentNotMaestroCapable('ghost-agent', 'unknown'));
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: any) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{
      ...baseTask,
      id: '1.1',
      preferred_agent: 'ghost-agent',
      fallback_agent: undefined,
      depends_on: [],
    }]),
  });

  await sweeper.tick();
  expect(plans.getTasks('p1')[0]?.status).toBe('failed');
  expect(logs.some(({ msg }) => msg.includes('not found'))).toBe(true);
});

test('not maestro-capable failure marks task failed and logs guidance', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const logs: Array<{ msg: string; meta?: any }> = [];
  const taskWriter = makeThrowingTaskWriter(db, new OrchestrateAgentNotMaestroCapable('codex-acp-fast', 'not_maestro_capable'));
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: any) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{
      ...baseTask,
      id: '1.1',
      preferred_agent: 'codex-acp-fast',
      fallback_agent: 'claude-acp-sonnet',
      depends_on: [],
    }]),
  });

  await sweeper.tick();
  expect(plans.getTasks('p1')[0]?.status).toBe('failed');
  expect(logs.some(({ msg }) => msg.includes('not maestro_capable'))).toBe(true);
});

test('leaf failure cascades plan to failed on subsequent tick', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const taskWriter = makeThrowingTaskWriter(db, new OrchestrateAgentNotMaestroCapable('codex-acp-fast', 'not_maestro_capable'));
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{
      ...baseTask,
      id: '1.1',
      preferred_agent: 'codex-acp-fast',
      fallback_agent: 'claude-acp-sonnet',
      depends_on: [],
    }]),
  });

  await sweeper.tick();
  expect(plans.getTasks('p1')[0]?.status).toBe('failed');
  await sweeper.tick();
  expect(plans.getPlan('p1')?.status).toBe('failed');
});

test('inlines task body into the dispatched prompt', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const prompts: string[] = [];
  const taskWriter = {
    file: (input: any) => {
      prompts.push(input.prompt);
      return makeTaskWriter(db).file(input);
    },
  } as TaskWriter;
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{
      ...baseTask,
      id: '1.1',
      heading: 'Task 1.1 - First',
      body: 'First body line.',
      depends_on: [],
    }]),
  });

  await sweeper.tick();
  expect(prompts[0]).toContain('First body line.');
  expect(prompts[0]).toContain('Task: Task 1.1 - First');
});

test('omits undefined body text from the dispatched prompt', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const prompts: string[] = [];
  const taskWriter = {
    file: (input: any) => {
      prompts.push(input.prompt);
      return makeTaskWriter(db).file(input);
    },
  } as TaskWriter;
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [{
      ...baseTask,
      id: '1.1',
      depends_on: [],
    }]),
  });

  await sweeper.tick();
  expect(prompts[0]).toContain('Implement Task 1.1 of plan p1.');
  expect(prompts[0]).not.toContain('undefined');
});
