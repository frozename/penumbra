import { describe, expect, it } from 'bun:test';
import { createPermissionCallback } from '../../src/worker/permission-callback.js';

describe('createPermissionCallback', () => {
  it("returns 'approve' for trust_mode='all'", async () => {
    const cb = createPermissionCallback('all');
    const decision = await cb({ toolName: 'fs.readTextFile', rawInput: {} });
    expect(decision).toBe('approve');
  });

  it("returns 'reject' for trust_mode='config'", async () => {
    const cb = createPermissionCallback('config');
    const decision = await cb({ toolName: 'fs.readTextFile', rawInput: {} });
    expect(decision).toBe('reject');
  });

  it('defaults to approve when trust mode is omitted', async () => {
    const cb = createPermissionCallback();
    const decision = await cb({ toolName: 'mcp__penumbra__chain.list_agents', rawInput: null });
    expect(decision).toBe('approve');
  });
});
