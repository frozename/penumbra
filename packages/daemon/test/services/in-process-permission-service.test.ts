import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services,
  migrate,
  loadSqliteVec,
  PermissionWriter,
  PermissionReader,
  PermissionEventBus,
} from '@penumbra/core';
import { InProcessPermissionService } from '../../src/services/in-process-permission-service.js';
import { permissionsDecideRoute } from '../../src/routes/permissions.js';
import { runPermissionTtlSweep } from '../../src/sweepers/permission-ttl.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function makeServices(db: Database, now: Date, opts?: { handoff?: { handoff_id: string; conversation_id: string } }): Services {
  let nUuid = 0;
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => 'machine-test' },
    uuid: () => `id-${++nUuid}`,
    clock: () => now,
    t0Writer: { write: () => {} },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => {}, warn: () => {} },
    handoffReader: {
      get: (id: string) => opts?.handoff && opts.handoff.handoff_id === id
        ? { handoff_id: id, conversation_id: opts.handoff.conversation_id, status: 'pending' }
        : null,
    },
  } as unknown as Services;
}

test('requestPermission resolves on permission.decided=approve', async () => {
  const now = new Date('2026-05-03T12:00:00.000Z');
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, { handoff: { handoff_id: 'h-1', conversation_id: 'c-1' } });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: 'h-1',
    agent_name: 'claude-acp-sonnet',
    tool_name: 'shell_run',
    context: { session_id: 's-1', initial_command: 'ls' },
  });

  // Find the just-created permission_id (uuid factory gives 'id-1' first).
  const permission_id = 'id-1';
  await permissionsDecideRoute(
    new Request('http://x/permissions/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', resolved_by: 'user' }),
    }),
    permission_id,
    services,
  );

  const result = await decision;
  expect(result.approved).toBe(true);
  svc.stop();
});

test('requestPermission resolves on permission.decided=reject with reason', async () => {
  const now = new Date('2026-05-03T12:00:00.000Z');
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, { handoff: { handoff_id: 'h-1', conversation_id: 'c-1' } });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: 'h-1',
    agent_name: 'claude-acp-sonnet',
    tool_name: 'shell_run.dangerous',
    context: { command: 'rm -rf /' },
  });

  await permissionsDecideRoute(
    new Request('http://x/permissions/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject', reason: 'too dangerous', resolved_by: 'user' }),
    }),
    'id-1',
    services,
  );

  const result = await decision;
  expect(result.approved).toBe(false);
  expect(result.reason).toBe('too dangerous');
  svc.stop();
});

test('requestPermission rejects when ttl sweep marks expired', async () => {
  const t0 = new Date('2026-05-03T12:00:00.000Z');
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, t0, { handoff: { handoff_id: 'h-1', conversation_id: 'c-1' } });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: 'h-1',
    agent_name: 'claude-acp-sonnet',
    tool_name: 'shell_run',
    context: {},
    ttl_seconds: 1,
  });

  // Advance the clock past TTL and run the sweeper.
  (services as any).clock = () => new Date('2026-05-03T12:00:10.000Z');
  runPermissionTtlSweep(services);

  await expect(decision).rejects.toThrow(/expired/);
  svc.stop();
});

test('requestPermission falls back to handoff_id as conversation_id when handoff is unknown', async () => {
  const now = new Date('2026-05-03T12:00:00.000Z');
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now /* no handoff override */);
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: 'h-orphan',
    agent_name: 'codex-acp-zed',
    tool_name: 'shell_run',
    context: {},
  });

  const row = services.permissionReader.get('id-1');
  expect(row?.conversation_id).toBe('h-orphan');

  await permissionsDecideRoute(
    new Request('http://x/permissions/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', resolved_by: 'user' }),
    }),
    'id-1',
    services,
  );
  expect((await decision).approved).toBe(true);
  svc.stop();
});

test('stop() rejects pending waiters', async () => {
  const now = new Date('2026-05-03T12:00:00.000Z');
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, { handoff: { handoff_id: 'h-1', conversation_id: 'c-1' } });
  const svc = new InProcessPermissionService(services);
  svc.start();

  const decision = svc.requestPermission({
    parent_handoff_id: 'h-1',
    agent_name: 'claude-acp-sonnet',
    tool_name: 'shell_run',
    context: {},
  });

  svc.stop();
  await expect(decision).rejects.toThrow(/stopped/);
});

test('throws if started twice or used before start', async () => {
  const now = new Date('2026-05-03T12:00:00.000Z');
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, now, { handoff: { handoff_id: 'h-1', conversation_id: 'c-1' } });
  const svc = new InProcessPermissionService(services);

  await expect(svc.requestPermission({
    parent_handoff_id: 'h-1',
    agent_name: 'codex-acp-zed',
    tool_name: 'shell_run',
    context: {},
  })).rejects.toThrow(/not started/);

  svc.start();
  svc.start(); // idempotent
  svc.stop();
});
