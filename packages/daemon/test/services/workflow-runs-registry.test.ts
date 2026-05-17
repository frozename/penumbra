import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createWorkflowRunsRegistry } from '../../src/services/workflow-runs-registry.js';

function freshDb(path: string) {
  return new Database(path);
}

test('register returns a fresh id each call', () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: freshDb(':memory:'),
    storageRoot: tmpdir(),
  });

  expect(registry.register('wf-a', 'proj')).toBe('wfrun-1');
  expect(registry.register('wf-a', 'proj')).toBe('wfrun-2');
});

test('verify returns the registered info', () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: freshDb(':memory:'),
    storageRoot: tmpdir(),
  });
  const id = registry.register('wf-a', 'proj');
  expect(registry.verify(id!)).toEqual({
    workflow_name: 'wf-a',
    project_id: 'proj',
    registered_at: new Date('2026-04-26T00:00:00Z').getTime(),
  });
});

test('verify returns null for an unknown id', () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: freshDb(':memory:'),
    storageRoot: tmpdir(),
  });
  expect(registry.verify('missing')).toBeNull();
});

test('register persists status and results across registry re-instantiation', () => {
  const root = mkdtempSync(join(tmpdir(), 'wfr-'));
  const dbPath = join(root, 'db.sqlite');
  try {
    let now = new Date('2026-04-26T00:00:00Z');
    const registry1 = createWorkflowRunsRegistry({
      uuid: () => 'wfrun-1',
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry1.register('wf-a', 'proj');
    expect(id).toBe('wfrun-1');
    expect(registry1.getStatus('wfrun-1')).toEqual({ status: 'running', started_at: now.getTime() });
    registry1.recordResult('wfrun-1', { ok: true });

    const registry2 = createWorkflowRunsRegistry({
      uuid: () => 'wfrun-2',
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    expect(registry2.getStatus('wfrun-1')).toEqual({
      status: 'completed',
      started_at: now.getTime(),
      finished_at: now.getTime(),
      result: { ok: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('register refuses to evict running runs when capacity is exhausted', () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: freshDb(':memory:'),
    storageRoot: tmpdir(),
    capacity: 2,
  });
  expect(registry.register('wf-1', 'proj')).toBe('wfrun-1');
  expect(registry.register('wf-2', 'proj')).toBe('wfrun-2');
  expect(registry.register('wf-3', 'proj')).toBeNull();
  expect(registry.verify('wfrun-1')).toEqual({
    workflow_name: 'wf-1',
    project_id: 'proj',
    registered_at: new Date('2026-04-26T00:00:00Z').getTime(),
  });
});

test('register evicts terminal runs before active runs', () => {
  let n = 0;
  const registry = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${++n}`,
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: freshDb(':memory:'),
    storageRoot: tmpdir(),
    capacity: 2,
  });
  const id1 = registry.register('wf-1', 'proj');
  const id2 = registry.register('wf-2', 'proj');
  registry.recordResult(id1!, { ok: true });
  expect(registry.register('wf-3', 'proj')).toBe('wfrun-3');
  expect(registry.verify(id1!)).toEqual({
    workflow_name: 'wf-1',
    project_id: 'proj',
    registered_at: new Date('2026-04-26T00:00:00Z').getTime(),
  });
  expect(registry.verify(id2!)).toEqual({
    workflow_name: 'wf-2',
    project_id: 'proj',
    registered_at: new Date('2026-04-26T00:00:00Z').getTime(),
  });
});

test('waitForResult enforces waiter caps', async () => {
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: freshDb(':memory:'),
    storageRoot: tmpdir(),
    waiterLimit: 1,
  });
  const id = registry.register('wf-a', 'proj');
  const first = registry.waitForResult(id!, 10_000);
  await expect(registry.waitForResult(id!, 10_000)).rejects.toThrow('waiter_capacity_exhausted');
  registry.recordResult(id!, { ok: true });
  expect(await first).toEqual({ status: 'completed', started_at: new Date('2026-04-26T00:00:00Z').getTime(), finished_at: new Date('2026-04-26T00:00:00Z').getTime(), result: { ok: true } });
});
