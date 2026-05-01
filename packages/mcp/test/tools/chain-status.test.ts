import { expect, test } from 'bun:test';
import { chainStatusHandler } from '../../src/tools/chain-status.js';

test('chainStatusHandler forwards handoff_id and returns the daemon response as JSON text', async () => {
  const calls: string[] = [];
  const fakeDaemon = {
    getHandoffStatus: async (id: string) => {
      calls.push(id);
      return {
        handoff_id: id,
        status: 'completed',
        error_summary: null,
        worker_id: 'worker-c',
        started_at: '2026-04-28T00:00:00Z',
        resolved_at: '2026-04-28T00:00:05Z',
        latency_seconds: 5,
        reliability: {
          status: 'complete',
          trustworthy: true,
          recommended_action: 'accept',
          summary: 'dispatch lifecycle and result evidence are complete',
        },
      };
    },
  } as any;
  const handler = chainStatusHandler(fakeDaemon);
  const res = await handler({ handoff_id: 'h-test' });
  expect(calls).toEqual(['h-test']);
  expect(res.content[0].type).toBe('text');
  expect(res.content[0].text).toMatch(/^[◌◐●◑] chain_status  /);
  expect(res.content[0].text).toContain('"status": "completed"');
  expect(res.content[0].text).toContain('"reliability": {');
  expect(res.content[0].text).toContain('"recommended_action": "accept"');
});
