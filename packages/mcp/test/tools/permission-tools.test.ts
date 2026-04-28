import { describe, expect, test } from 'bun:test';
import { DaemonHttpError } from '../../src/daemon-client.js';
import {
  permissionListPendingHandler, PermissionListPendingInputShape,
} from '../../src/tools/permission-list-pending.js';
import {
  permissionGetHandler, PermissionGetInputShape,
} from '../../src/tools/permission-get.js';
import {
  permissionApproveHandler, PermissionApproveInputShape,
} from '../../src/tools/permission-approve.js';

function makeFakeDaemon() {
  return {
    listPermissions: async (opts: any) => ({ permissions: [{ permission_id: 'p-1', status: 'pending', tool_name: 't', conversation_id: opts.conversation_id ?? 'c' }] }),
    getPermission: async (id: string) => ({ permission: { permission_id: id, status: 'pending', tool_name: 't' } }),
    approvePermission: async (id: string, body: any) => ({ permission_id: id, status: body.decision === 'approve' ? 'approved' : 'rejected', decided_at: 't' }),
  } as any;
}

describe('permission-list-pending tool', () => {
  test('forwards conversation_id filter to daemon and returns rows', async () => {
    const handler = permissionListPendingHandler(makeFakeDaemon());
    const out = await handler({ conversation_id: 'conv-123' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.permissions[0].conversation_id).toBe('conv-123');
  });
  test('input shape declares optional fields', () => {
    expect(PermissionListPendingInputShape).toBeDefined();
  });
});

describe('permission-get tool', () => {
  test('returns the row', async () => {
    const handler = permissionGetHandler(makeFakeDaemon());
    const out = await handler({ permission_id: 'p-1' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.permission.permission_id).toBe('p-1');
  });
  test('returns 404-shaped body when daemon throws not_found', async () => {
    const fake = makeFakeDaemon();
    fake.getPermission = async () => { throw new DaemonHttpError('daemon /permissions/nope: HTTP 404', 404); };
    const handler = permissionGetHandler(fake);
    const out = await handler({ permission_id: 'nope' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.error?.code).toBe('not_found');
  });

  test('passes through structured error body from daemon (preserves richer 404 info)', async () => {
    const fake = makeFakeDaemon();
    const richBody = { error: { code: 'not_found', message: 'permission perm-x does not exist', hint: 'check spelling' } };
    fake.getPermission = async () => { throw new DaemonHttpError('daemon: HTTP 404', 404, richBody); };
    const handler = permissionGetHandler(fake);
    const out = await handler({ permission_id: 'perm-x' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.error?.hint).toBe('check spelling');
  });
});

describe('permission-approve tool', () => {
  test('approve passes through', async () => {
    const handler = permissionApproveHandler(makeFakeDaemon());
    const out = await handler({ permission_id: 'p-1', decision: 'approve', remember: 'this_dispatch' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.status).toBe('approved');
  });
  test('reject passes through', async () => {
    const handler = permissionApproveHandler(makeFakeDaemon());
    const out = await handler({ permission_id: 'p-1', decision: 'reject', reason: 'no third-party calls' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.status).toBe('rejected');
  });
});
