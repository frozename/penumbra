import { expect, test } from 'bun:test';
import { DaemonHttpError } from '../../src/daemon-client.js';
import { planStartHandler } from '../../src/tools/plan-start.js';

function fakeDaemon(impl: { planStart: (req: any) => Promise<any> }) {
  return impl;
}

test('plan.start happy path returns plan_id + status', async () => {
  const daemon = fakeDaemon({
    planStart: async (req) => ({ plan_id: 'abc-123-1700000000', status: 'running' }),
  });
  const handler = planStartHandler(daemon as any);
  const result = await handler({ file_path: '/tmp/plan.md' });
  expect(result.plan_id).toBe('abc-123-1700000000');
  expect(result.status).toBe('running');
});

test('plan.start surfaces validation_failed details', async () => {
  const daemon = fakeDaemon({
    planStart: async (req) => {
      throw new DaemonHttpError('daemon /plans: HTTP 400', 400, {
        error: 'validation_failed',
        details: [{ task_id: '1.1', rule: 'unknown_project', message: 'unknown project foo' }],
      });
    },
  });
  const handler = planStartHandler(daemon as any);
  await expect(handler({ file_path: '/tmp/plan.md' })).rejects.toThrow(/validation_failed/);
  await expect(handler({ file_path: '/tmp/plan.md' })).rejects.toThrow(/unknown project foo/);
});
