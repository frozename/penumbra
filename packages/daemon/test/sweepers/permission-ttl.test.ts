import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services, migrate, loadSqliteVec,
  PermissionWriter, PermissionReader, PermissionEventBus,
} from '@penumbra/core';
import { runPermissionTtlSweep } from '../../src/sweepers/permission-ttl.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function makeServices(db: Database, now: Date): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => 'machine-test' }, uuid: (() => { let n = 0; return () => `evt-${++n}`; })(),
    clock: () => now,
    t0Writer: { write: () => {} },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

test('runPermissionTtlSweep transitions stale rows to expired and emits events', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, new Date('2026-04-28T12:02:00.000Z'));

  const baseTs = new Date('2026-04-28T12:00:00.000Z');
  services.permissionWriter.create({
    permission_id: 'p-stale', parent_handoff_id: 'h-1', conversation_id: 'c',
    agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 60, now: baseTs,
  });
  services.permissionWriter.create({
    permission_id: 'p-fresh', parent_handoff_id: 'h-1', conversation_id: 'c',
    agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 600, now: baseTs,
  });
  const seen: any[] = [];
  services.permissionEvents.subscribe((e) => seen.push(e));

  const n = runPermissionTtlSweep(services);
  expect(n).toBe(1);
  expect(services.permissionReader.get('p-stale')?.status).toBe('expired');
  expect(services.permissionReader.get('p-fresh')?.status).toBe('pending');
  expect(seen.map((e) => e.kind)).toEqual(['permission.expired']);
  expect(seen[0].permission_id).toBe('p-stale');
});

test('runPermissionTtlSweep is idempotent on subsequent calls', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, new Date('2026-04-28T12:02:00.000Z'));

  services.permissionWriter.create({
    permission_id: 'p-stale', parent_handoff_id: 'h-1', conversation_id: 'c',
    agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 60, now: new Date('2026-04-28T12:00:00.000Z'),
  });
  expect(runPermissionTtlSweep(services)).toBe(1);
  expect(runPermissionTtlSweep(services)).toBe(0);
});
