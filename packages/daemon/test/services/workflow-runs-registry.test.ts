import { expect, test } from 'bun:test';
import { createWorkflowRunsRegistry } from '../../src/services/workflow-runs-registry.js';

test('register returns a fresh id each call', () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date('2026-04-26T00:00:00Z'),
  });

  expect(registry.register('wf-a', 'proj')).toBe('wfrun-1');
  expect(registry.register('wf-a', 'proj')).toBe('wfrun-2');
});

test('verify returns the registered info', () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => new Date('2026-04-26T00:00:00Z'),
  });
  const id = registry.register('wf-a', 'proj');
  expect(registry.verify(id)).toEqual({
    workflow_name: 'wf-a',
    project_id: 'proj',
    registered_at: new Date('2026-04-26T00:00:00Z').getTime(),
  });
});

test('verify returns null for an unknown id', () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => new Date('2026-04-26T00:00:00Z'),
  });
  expect(registry.verify('missing')).toBeNull();
});

test('verify expires and removes old entries', () => {
  let now = new Date('2026-04-26T00:00:00Z');
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => now,
    ttlMs: 1000,
  });
  const id = registry.register('wf-a', 'proj');
  now = new Date('2026-04-26T00:00:02Z');
  expect(registry.verify(id)).toBeNull();
  expect(registry.verify(id)).toBeNull();
});

test('unregister removes the entry', () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => new Date('2026-04-26T00:00:00Z'),
  });
  const id = registry.register('wf-a', 'proj');
  registry.unregister(id);
  expect(registry.verify(id)).toBeNull();
});

test('registry caps size and drops oldest entries first', () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date('2026-04-26T00:00:00Z'),
  });
  for (let i = 0; i < 1025; i++) {
    registry.register(`wf-${i}`, 'proj');
  }
  expect(registry.verify('wfrun-1')).toBeNull();
  expect(registry.verify('wfrun-1025')).toEqual({
    workflow_name: 'wf-1024',
    project_id: 'proj',
    registered_at: new Date('2026-04-26T00:00:00Z').getTime(),
  });
});
