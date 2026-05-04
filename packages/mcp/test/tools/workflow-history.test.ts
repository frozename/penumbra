import { expect, mock, test } from 'bun:test';
import { workflowHistoryHandler } from '../../src/tools/workflow-history.js';

test('passes name to daemon.workflowHistory and returns wrapped text content', async () => {
  const daemon = { workflowHistory: mock(async () => ({ history: [{ ran_at: '2026-05-04T00:00:00.000Z', outcome: 'success' }] })) };
  const handler = workflowHistoryHandler(daemon as any);
  const r = await handler({ name: 'demo' });
  expect(daemon.workflowHistory).toHaveBeenCalledWith({ name: 'demo' });
  expect(JSON.parse(r.content[0].text)).toEqual({ history: [{ ran_at: '2026-05-04T00:00:00.000Z', outcome: 'success' }] });
});
