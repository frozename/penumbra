import { expect, test } from 'bun:test';
import { memoryVerifyAuthorizeHandler } from '../../src/tools/memory-verify-authorize.js';

test('memory_verify_authorize handler forwards the parsed payload', async () => {
  const calls: unknown[] = [];
  const handler = memoryVerifyAuthorizeHandler({
    memoryVerifyAuthorize: async (req: unknown) => {
      calls.push(req);
      return { ok: true, authorized: true, events_written: 1 };
    },
  } as any);
  const out = await handler({
    handoff_id: 'h1',
    verdict: 'passed',
    basis: { kind: 'manual_override', reason: 'ok', authorized_by: 'lead' },
  });
  expect(calls).toHaveLength(1);
  expect(out.content[0].text).toContain('"authorized": true');
});
