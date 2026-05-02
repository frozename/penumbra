import { describe, expect, test } from 'bun:test';
import { PermissionDaemonClient } from '../../src/worker/permission-daemon-client.js';

interface FakeClient {
  createPermission: (body: any) => Promise<any>;
  getPermission: (id: string) => Promise<any>;
  decidePermission: (id: string, body: any) => Promise<any>;
}

class FakeEventSource {
  listeners = new Map<string, Set<(evt: any) => void>>();
  reconnectListeners = new Set<() => void>();
  closed = false;
  addEventListener(name: string, fn: (evt: any) => void) {
    if (name === 'onReconnect') {
      this.reconnectListeners.add(fn);
      return;
    }
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  onReconnect(fn: () => void) {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }
  emit(name: string, payload: { permission_id: string; data: any }) {
    const data = JSON.stringify(payload.data);
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data, lastEventId: `seq:${1}` });
    }
  }
  onReconnectFire() {
    for (const fn of this.reconnectListeners) fn();
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
  const seen: any[] = [];
  const client = new PermissionDaemonClient({
    penumbraClient: makeFakeClient() as any,
    makeEventSource: () => fakeEs as any,
    uuid: () => 'perm-fixed',
    log: { info: () => {}, warn: () => {} } as any,
    onPermissionEvent: (event) => seen.push(event),
  });
  await client.start();

  const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });
    await Promise.resolve();
    // Simulate operator approving via SSE.
    fakeEs.emit('permission.decided', {
      permission_id: 'perm-fixed',
      data: { permission_id: 'perm-fixed', decision: 'approve', remember: 'this_dispatch', reason: null },
    });
  const result = await promise;
  expect(result.decision).toBe('approve');
  expect(result.remember).toBe('this_dispatch');
  expect(seen).toEqual([
    {
      kind: 'permission_requested',
      permission_id: 'perm-fixed',
      handoff_id: 'h-1',
      conversation_id: 'c',
      agent: 'a',
      tool_name: 't',
      ttl_at: 't',
    },
    {
      kind: 'permission_decided',
      permission_id: 'perm-fixed',
      handoff_id: undefined,
      conversation_id: undefined,
      agent: undefined,
      tool_name: undefined,
      decision: 'approve',
      decided_by: undefined,
    },
  ]);
});

test('requestPermission rejects on permission.expired', async () => {
  const fakeEs = new FakeEventSource();
  const seen: any[] = [];
  const client = new PermissionDaemonClient({
    penumbraClient: makeFakeClient() as any,
    makeEventSource: () => fakeEs as any,
    uuid: () => 'perm-fixed',
    log: { info: () => {}, warn: () => {} } as any,
    onPermissionEvent: (event) => seen.push(event),
  });
  await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });
    await Promise.resolve();
    fakeEs.emit('permission.expired', {
      permission_id: 'perm-fixed',
      data: {
        permission_id: 'perm-fixed',
        parent_handoff_id: 'h-1',
        conversation_id: 'c',
        agent_name: 'a',
        tool_name: 't',
        ttl_at: 't',
        expired_at: 't',
      },
    });
    await expect(promise).rejects.toThrow(/expired/);
    expect(seen).toEqual([
      {
        kind: 'permission_requested',
        permission_id: 'perm-fixed',
        handoff_id: 'h-1',
        conversation_id: 'c',
        agent: 'a',
        tool_name: 't',
        ttl_at: 't',
      },
      {
        kind: 'permission_expired',
        permission_id: 'perm-fixed',
        handoff_id: 'h-1',
        conversation_id: 'c',
        agent: 'a',
        tool_name: 't',
        ttl_at: 't',
      },
    ]);
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
  const seen: any[] = [];
  const client = new PermissionDaemonClient({
    penumbraClient: makeFakeClient() as any,
    makeEventSource: () => fakeEs as any,
    uuid: () => 'perm-fixed',
    log: { info: () => {}, warn: () => {} } as any,
    onPermissionEvent: (event) => seen.push(event),
  });
  await client.start();
  // No throw — just observes that emitting an unknown id doesn't crash.
  fakeEs.emit('permission.decided', {
    permission_id: 'unknown',
    data: {
      permission_id: 'unknown',
      parent_handoff_id: 'h-unknown',
      conversation_id: 'c-unknown',
      agent_name: 'agent-unknown',
      tool_name: 'tool.unknown',
      decision: 'approve',
      decided_by: 'operator',
    },
  });
  expect(fakeEs.closed).toBe(false);
  expect(seen).toEqual([
    {
      kind: 'permission_decided',
      permission_id: 'unknown',
      handoff_id: 'h-unknown',
      conversation_id: 'c-unknown',
      agent: 'agent-unknown',
      tool_name: 'tool.unknown',
      decision: 'approve',
      decided_by: 'operator',
    },
  ]);
});

  test('reconnect -> terminal pending row converges via GET', async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.getPermission = async (id) => ({
      permission: {
        permission_id: id,
        parent_handoff_id: 'h-1',
        conversation_id: 'c',
        agent_name: 'a',
        tool_name: 't',
        raw_input_json: '{}',
        status: 'approved',
        remember_scope: 'this_dispatch',
        decision_reason: 'ok',
        decided_by: 'operator',
        ttl_at: 't',
        created_at: 't',
        decided_at: 't',
      },
    });
    const client = new PermissionDaemonClient({
      penumbraClient: fakeClient as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });

    fakeEs.onReconnectFire();
    await expect(promise).resolves.toEqual({
      decision: 'approve',
      remember: 'this_dispatch',
      reason: 'ok',
    });
  });

  test('reconnect -> still-pending row keeps waiting', async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.getPermission = async (id) => ({
      permission: {
        permission_id: id,
        parent_handoff_id: 'h-1',
        conversation_id: 'c',
        agent_name: 'a',
        tool_name: 't',
        raw_input_json: '{}',
        status: 'pending',
        remember_scope: null,
        decision_reason: null,
        decided_by: null,
        ttl_at: 't',
        created_at: 't',
        decided_at: null,
      },
    });
    const client = new PermissionDaemonClient({
      penumbraClient: fakeClient as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });

    fakeEs.onReconnectFire();
    await Promise.resolve();
    expect((client as any).waiters.size).toBe(1);
    expect(promise).toBeInstanceOf(Promise);
  });

  test('reconnect -> 404 from GET rejects waiter', async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.getPermission = async () => {
      const err: any = new Error('missing');
      err.status = 404;
      throw err;
    };
    const client = new PermissionDaemonClient({
      penumbraClient: fakeClient as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });

    fakeEs.onReconnectFire();
    await expect(promise).rejects.toThrow(/not found|404/i);
  });
});
