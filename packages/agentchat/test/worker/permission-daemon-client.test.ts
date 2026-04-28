import { describe, expect, test } from 'bun:test';
import { PermissionDaemonClient } from '../../src/worker/permission-daemon-client.js';

interface FakeClient {
  createPermission: (body: any) => Promise<any>;
  getPermission: (id: string) => Promise<any>;
  decidePermission: (id: string, body: any) => Promise<any>;
}

class FakeEventSource {
  listeners = new Map<string, Set<(evt: any) => void>>();
  closed = false;
  addEventListener(name: string, fn: (evt: any) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  emit(name: string, payload: { permission_id: string; data: any }) {
    const data = JSON.stringify(payload.data);
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data, lastEventId: `seq:${1}` });
    }
  }
  close() { this.closed = true; }
}

function makeFakeClient(): FakeClient {
  return {
    createPermission: async (body) => ({ permission_id: body.permission_id, status: 'pending', ttl_at: 't' }),
    getPermission: async (id) => ({ permission: { permission_id: id, status: 'pending' } }),
    decidePermission: async () => ({ status: 'approved' }),
  };
}

describe('PermissionDaemonClient', () => {
  test('requestPermission registers waiter BEFORE POST and resolves on SSE decided event', async () => {
    const fakeEs = new FakeEventSource();
    const client = new PermissionDaemonClient({
      penumbraClient: makeFakeClient() as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });
    // Simulate operator approving via SSE.
    fakeEs.emit('permission.decided', {
      permission_id: 'perm-fixed',
      data: { permission_id: 'perm-fixed', decision: 'approve', remember: 'this_dispatch', reason: null },
    });
    const result = await promise;
    expect(result.decision).toBe('approve');
    expect(result.remember).toBe('this_dispatch');
  });

  test('requestPermission rejects on permission.expired', async () => {
    const fakeEs = new FakeEventSource();
    const client = new PermissionDaemonClient({
      penumbraClient: makeFakeClient() as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });
    fakeEs.emit('permission.expired', {
      permission_id: 'perm-fixed',
      data: { permission_id: 'perm-fixed', ttl_at: 't', expired_at: 't' },
    });
    await expect(promise).rejects.toThrow(/expired/);
  });

  test('requestPermission with createPermission HTTP failure rejects', async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.createPermission = async () => { throw new Error('http 500'); };
    const client = new PermissionDaemonClient({
      penumbraClient: fakeClient as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    await expect(client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    })).rejects.toThrow(/http 500/);
  });

  test('decided event for an unknown id is silently ignored', async () => {
    const fakeEs = new FakeEventSource();
    const client = new PermissionDaemonClient({
      penumbraClient: makeFakeClient() as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();
    // No throw — just observes that emitting an unknown id doesn't crash.
    fakeEs.emit('permission.decided', {
      permission_id: 'unknown',
      data: { permission_id: 'unknown', decision: 'approve' },
    });
    expect(fakeEs.closed).toBe(false);
  });
});
