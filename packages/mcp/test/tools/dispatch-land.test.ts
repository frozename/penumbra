import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { DispatchLandInputShape, dispatchLandHandler } from '../../src/tools/dispatch-land.js';
import { TOOL_REGISTRY } from '../../src/tools/registry.js';

describe('dispatch.land tool', () => {
  test('DispatchLandInputShape requires handoff_id + commit_message', () => {
    const schema = z.object(DispatchLandInputShape);
    expect(() => schema.parse({ handoff_id: 'h-1', commit_message: 'feat: msg' })).not.toThrow();
    expect(() => schema.parse({ handoff_id: 'h-1' })).toThrow();
    expect(() => schema.parse({ commit_message: 'feat: msg' })).toThrow();
  });

  test('dispatchLandHandler delegates to daemon and returns JSON text', async () => {
    const calls: any[] = [];
    const handler = dispatchLandHandler({
      dispatchLand: async (input: any) => {
        calls.push(input);
        return {
          ok: true,
          commit_sha: 'abc123',
          message_subject: 'feat: msg',
          branch_deleted: true,
          pr_closed: false,
        };
      },
    } as any);

    const res = await handler({
      handoff_id: 'h-1',
      commit_message: 'feat: msg',
      mode: 'squash',
      delete_branch: true,
      force: false,
    });

    expect(calls).toEqual([{
      handoff_id: 'h-1',
      commit_message: 'feat: msg',
      mode: 'squash',
      delete_branch: true,
      force: false,
    }]);
    const content = (res as any).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('"ok": true');
    expect(content[0].text).toContain('"commit_sha": "abc123"');
  });

  test('registry exposes dispatch.land as mutating', () => {
    expect(TOOL_REGISTRY['dispatch.land']).toBeDefined();
    expect(TOOL_REGISTRY['dispatch.land'].readOnly).toBe(false);
  });
});
