import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSqliteVec, migrate, PlanWriter, TaskWriter, TaskEventBus, OrchestrateAgentNotMaestroCapable } from '../../../core/src/index.ts';
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

function makeCapturingTaskWriter(db: Database, capture: Array<any>): TaskWriter {
  const writer = makeTaskWriter(db);
  return {
    ...writer,
    file: (input: any) => {
      capture.push(input);
      return writer.file(input);
    },
  } as TaskWriter;
}

function seedMaestroSession(db: Database, taskId: string, handoffId: string): void {
  db.run(
    `INSERT INTO maestro_sessions (
      task_id, chain_handoff_id, agent_id, started_at,
      wall_clock_budget_ms, cost_budget_cents, sub_dispatch_budget
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [taskId, handoffId, 'agent', Date.now(), 1, 1, 1],
  );
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
  const logs: Array<{ msg: string; meta?: any }> = [];
  plans.register({ plan_id: 'p1', file_path: makePlanFile('p1.md'), home_project: 'penumbra', tasks: [{ task_meta_id: '1.1', project_id: 'penumbra' }] });

  const sweeper = createPlanRuntimeSweeper({
    db, plans, taskWriter,
    log: { warn: (msg: string, meta?: any) => logs.push({ msg, meta }) },
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

test('single same-project dep threads branch_base to the filed orchestrate task', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: any[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [
      { task_meta_id: '1.1', project_id: 'penumbra' },
      { task_meta_id: '1.2', project_id: 'penumbra' },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [] },
      { ...baseTask, id: '1.2', depends_on: ['1.1'] },
    ]),
  });

  await sweeper.tick();
  const planTask11 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.1');
  expect(planTask11?.task_id_in_board).toBeDefined();
  seedMaestroSession(db, planTask11!.task_id_in_board!, 'h-root-1');
  plans.markTaskStatus('p1', '1.1', 'completed');

  await sweeper.tick();
  expect(calls[1]?.branch_base).toBe('agent/h-root-1');
});

test('cross-project direct dep can branch off a transitive same-project ancestor', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: any[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [
      { task_meta_id: '1.1', project_id: 'penumbra' },
      { task_meta_id: '1.2', project_id: 'sirius' },
      { task_meta_id: '1.3', project_id: 'penumbra' },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [] },
      { ...baseTask, id: '1.2', depends_on: ['penumbra/1.1'], project: 'sirius' },
      { ...baseTask, id: '1.3', depends_on: ['sirius/1.2'] },
    ]),
  });

  await sweeper.tick();
  const planTask11 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.1');
  const planTask12 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.2');
  seedMaestroSession(db, planTask11!.task_id_in_board!, 'h-root-1');
  plans.markTaskStatus('p1', '1.1', 'completed');

  await sweeper.tick();
  seedMaestroSession(db, planTask12!.task_id_in_board!, 'h-cross-1');
  plans.markTaskStatus('p1', '1.2', 'completed');
  await sweeper.tick();
  expect(calls[2]?.branch_base).toBe('agent/h-root-1');
});

test('transitive same-project ancestors warn and choose the latest completed ancestor', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: any[] = [];
  const logs: Array<{ msg: string; meta?: any }> = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [
      { task_meta_id: '1.1', project_id: 'penumbra' },
      { task_meta_id: '1.2', project_id: 'sirius' },
      { task_meta_id: '1.3', project_id: 'penumbra' },
      { task_meta_id: '1.4', project_id: 'penumbra' },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: any) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [] },
      { ...baseTask, id: '1.2', depends_on: ['penumbra/1.1'], project: 'sirius' },
      { ...baseTask, id: '1.3', depends_on: [] },
      { ...baseTask, id: '1.4', depends_on: ['1.3', 'sirius/1.2'] },
    ]),
  });

  await sweeper.tick();
  const task11 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.1');
  const task13 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.3');
  const task12 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.2');
  seedMaestroSession(db, task11!.task_id_in_board!, 'h-root-1');
  seedMaestroSession(db, task13!.task_id_in_board!, 'h-root-3');
  plans.markTaskStatus('p1', '1.1', 'completed');
  plans.markTaskStatus('p1', '1.3', 'completed');

  await sweeper.tick();
  seedMaestroSession(db, task12!.task_id_in_board!, 'h-cross-1');
  plans.markTaskStatus('p1', '1.2', 'completed');
  await sweeper.tick();
  expect(calls[3]?.branch_base).toBe('agent/h-root-3');
  expect(logs.some((entry) => String(entry.msg).includes('multiple same-project ancestors'))).toBe(true);
});

test('incomplete same-project ancestor does not become branch_base', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: any[] = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [
      { task_meta_id: '1.1', project_id: 'penumbra' },
      { task_meta_id: '1.2', project_id: 'sirius' },
      { task_meta_id: '1.3', project_id: 'penumbra' },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [] },
      { ...baseTask, id: '1.2', depends_on: ['penumbra/1.1'], project: 'sirius' },
      { ...baseTask, id: '1.3', depends_on: ['sirius/1.2'] },
    ]),
  });

  await sweeper.tick();
  const planTask11 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.1');
  const planTask12 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.2');
  seedMaestroSession(db, planTask11!.task_id_in_board!, 'h-root-1');
  seedMaestroSession(db, planTask12!.task_id_in_board!, 'h-cross-1');
  plans.markTaskStatus('p1', '1.1', 'completed');

  await sweeper.tick();
  expect(calls[2]?.branch_base).toBeUndefined();
});

test('multi same-project deps warn and choose the latest completed ancestor', async () => {
  const db = makeDb();
  const plans = new PlanWriter(db);
  const calls: any[] = [];
  const logs: Array<{ msg: string; meta?: any }> = [];
  const taskWriter = makeCapturingTaskWriter(db, calls);
  plans.register({
    plan_id: 'p1',
    file_path: makePlanFile('p1.md'),
    home_project: 'penumbra',
    tasks: [
      { task_meta_id: '1.1', project_id: 'penumbra' },
      { task_meta_id: '1.2', project_id: 'sirius' },
      { task_meta_id: '1.3', project_id: 'penumbra' },
      { task_meta_id: '1.4', project_id: 'penumbra' },
    ],
  });
  const sweeper = createPlanRuntimeSweeper({
    db,
    plans,
    taskWriter,
    log: { warn: (msg: string, meta?: any) => logs.push({ msg, meta }) },
    planParser: fakeParser({ plan_id: 'p1', home_project: 'penumbra' }, [
      { ...baseTask, id: '1.1', depends_on: [] },
      { ...baseTask, id: '1.2', depends_on: ['penumbra/1.1'], project: 'sirius' },
      { ...baseTask, id: '1.3', depends_on: [] },
      { ...baseTask, id: '1.4', depends_on: ['1.3', 'sirius/1.2'] },
    ]),
  });

  await sweeper.tick();
  const planTask11 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.1');
  const planTask12 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.2');
  const planTask13 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.3');
  seedMaestroSession(db, planTask11!.task_id_in_board!, 'h-1');
  seedMaestroSession(db, planTask13!.task_id_in_board!, 'h-3');
  expect(calls[0]?.branch_base).toBeUndefined();
  expect(calls[1]?.branch_base).toBeUndefined();
  plans.markTaskStatus('p1', '1.1', 'completed');
  plans.markTaskStatus('p1', '1.3', 'completed');
  await sweeper.tick();
  seedMaestroSession(db, planTask12!.task_id_in_board!, 'h-2');
  plans.markTaskStatus('p1', '1.2', 'completed');
  await sweeper.tick();
  expect(calls[3]?.branch_base).toBe('agent/h-3');
  expect(logs.some((entry) => String(entry.msg).includes('multiple same-project ancestors'))).toBe(true);
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
  const planTask11 = plans.getTasks('p1').find((t) => t.task_meta_id === '1.1');
  seedMaestroSession(db, planTask11!.task_id_in_board!, 'h-complete');
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
  expect(logs.length).toBeGreaterThan(0);
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
  expect(logs.length).toBeGreaterThan(0);
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
