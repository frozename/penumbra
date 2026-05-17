import { expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createWorkflowRunsRegistry } from '../../src/services/workflow-runs-registry.js';

function freshDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result_json TEXT,
      error_json TEXT,
      result_spill_path TEXT,
      error_spill_path TEXT,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
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

test('register persists status and results across registry re-instantiation', async () => {
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
    await expect(registry1.getStatus('wfrun-1')).resolves.toEqual({ status: 'running', started_at: now.getTime() });
    await registry1.recordResult('wfrun-1', { ok: true });

    const registry2 = createWorkflowRunsRegistry({
      uuid: () => 'wfrun-2',
      clock: () => now,
      db: freshDb(dbPath),
      storageRoot: root,
    });
    await expect(registry2.getStatus('wfrun-1')).resolves.toEqual({
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

test('register evicts terminal runs before active runs', async () => {
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
  await registry.recordResult(id1!, { ok: true });
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
  await registry.recordResult(id!, { ok: true });
  expect(await first).toEqual({ status: 'completed', started_at: new Date('2026-04-26T00:00:00Z').getTime(), finished_at: new Date('2026-04-26T00:00:00Z').getTime(), result: { ok: true } });
});

test('verify returns null for expired runs', async () => {
  let now = new Date('2026-04-26T00:10:01Z');
  const registry = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => now,
    db: freshDb(':memory:'),
    storageRoot: tmpdir(),
    ttlMs: 10_000,
  });
  const id = registry.register('wf-a', 'proj');
  expect(id).toBe('wfrun-1');
  now = new Date('2026-04-26T00:10:12Z');
  expect(registry.verify('wfrun-1')).toBeNull();
  await expect(registry.getStatus('wfrun-1')).resolves.toBeNull();
});

test('recordResult persists large payloads without trusting inline spill envelopes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfr-spill-'));
  const dbPath = join(root, 'db.sqlite');
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => 'wfrun-1',
      clock: () => new Date('2026-04-26T00:00:00Z'),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry.register('wf-a', 'proj');
    expect(id).toBe('wfrun-1');
    await registry.recordResult('wfrun-1', { __kind: 'spill', path: '../../escape' });
    await expect(registry.getStatus('wfrun-1')).resolves.toEqual({
      status: 'completed',
      started_at: new Date('2026-04-26T00:00:00Z').getTime(),
      finished_at: new Date('2026-04-26T00:00:00Z').getTime(),
      result: { __kind: 'spill', path: '../../escape' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recordResult yields before the spill write completes and persists the result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfr-smoke-'));
  const dbPath = join(root, 'db.sqlite');
  try {
    const registry = createWorkflowRunsRegistry({
      uuid: () => 'wfrun-1',
      clock: () => new Date('2026-04-26T00:00:00Z'),
      db: freshDb(dbPath),
      storageRoot: root,
    });
    const id = registry.register('wf-a', 'proj');
    expect(id).toBe('wfrun-1');
    const payload = { data: 'x'.repeat(200_000) };
    const started = performance.now();
    const writePromise = registry.recordResult('wfrun-1', payload);
    await Promise.resolve();
    expect(performance.now() - started).toBeLessThan(10);
    await writePromise;
    await expect(registry.getStatus('wfrun-1')).resolves.toEqual({
      status: 'completed',
      started_at: new Date('2026-04-26T00:00:00Z').getTime(),
      finished_at: new Date('2026-04-26T00:00:00Z').getTime(),
      result: payload,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
