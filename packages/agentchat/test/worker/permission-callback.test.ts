import { describe, expect, it } from 'bun:test';
import { createPermissionCallback } from '../../src/worker/permission-callback.js';

describe('createPermissionCallback', () => {
  it("returns 'approve' for trust_mode='all'", async () => {
    const cb = createPermissionCallback('all');
    const decision = await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' });
    expect(decision).toBe('approve');
  });

  it("returns 'reject' for trust_mode='config'", async () => {
    const cb = createPermissionCallback('config');
    const decision = await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' });
    expect(decision).toBe('reject');
  });

  it('defaults to approve when trust mode is omitted', async () => {
    const cb = createPermissionCallback();
    const decision = await cb({ toolName: 'mcp__penumbra__chain.list_agents', rawInput: null, dispatchId: 'test' });
    expect(decision).toBe('approve');
  });
});

describe('createPermissionCallback (v2 form, with allowlist + daemon)', () => {
  function makeFakeDaemon(decision: 'approve' | 'reject', remember: 'this_call' | 'this_dispatch' | null = null) {
    return {
      requestPermission: async () => ({ decision, remember, reason: null }),
    } as any;
  }

  it("v2: trustMode='all' short-circuits to approve without daemon round-trip", async () => {
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: 'all',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c-1', agentName: 'claude-acp-sonnet',
      ttlSeconds: 300,
      daemonClient: { requestPermission: async () => { calls.push('called'); return { decision: 'reject', remember: null, reason: null }; } } as any,
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' })).toBe('approve');
    expect(calls).toEqual([]);
  });

  it("v2: allowlist match short-circuits to approve under 'config'", async () => {
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: ['mcp__penumbra__*'],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: { requestPermission: async () => { calls.push('called'); return { decision: 'reject', remember: null, reason: null }; } } as any,
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'mcp__penumbra__chain.list_agents', rawInput: {}, dispatchId: 'test' })).toBe('approve');
    expect(calls).toEqual([]);
  });

  it("v2: off-list under 'config' calls daemon and returns its decision", async () => {
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: ['mcp__penumbra__*'],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: makeFakeDaemon('approve'),
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'mcp__sirius__chat', rawInput: { msg: 'hi' }, dispatchId: 'test' })).toBe('approve');
  });

  it("v2: 'this_dispatch' remember adds tool to per-dispatch cache; second call short-circuits", async () => {
    const perDispatch = new Set<string>();
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: {
        requestPermission: async (input: any) => {
          calls.push(input.tool_name);
          return { decision: 'approve', remember: 'this_dispatch', reason: null };
        },
      } as any,
      perDispatchAllowlist: perDispatch,
    });
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' })).toBe('approve');
    expect(calls).toEqual(['fs.readTextFile']);
    expect(perDispatch.has('fs.readTextFile')).toBe(true);
    // Second call to the same tool should NOT round-trip the daemon.
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' })).toBe('approve');
    expect(calls).toEqual(['fs.readTextFile']); // still only one call
  });

  it("v2: daemon Promise rejection ⇒ 'reject' (fail closed)", async () => {
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: { requestPermission: async () => { throw new Error('expired'); } } as any,
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' })).toBe('reject');
  });

  it("v2: 'this_call' remember does NOT populate per-dispatch cache", async () => {
    const perDispatch = new Set<string>();
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: {
        requestPermission: async (input: any) => {
          calls.push(input.tool_name);
          return { decision: 'approve', remember: 'this_call', reason: null };
        },
      } as any,
      perDispatchAllowlist: perDispatch,
    });
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' })).toBe('approve');
    expect(perDispatch.has('fs.readTextFile')).toBe(false);
    // Second call must round-trip the daemon (cache wasn't populated)
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {}, dispatchId: 'test' })).toBe('approve');
    expect(calls.length).toBe(2);
  });

  it("v2: daemon-returned 'reject' (operator denied) maps to 'reject'", async () => {
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: {
        requestPermission: async () => ({ decision: 'reject', remember: null, reason: 'operator denied' }),
      } as any,
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'mcp__sirius__chat', rawInput: {}, dispatchId: 'test' })).toBe('reject');
  });
});
