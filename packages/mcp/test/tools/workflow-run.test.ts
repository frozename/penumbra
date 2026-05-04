import { expect, mock, test } from 'bun:test';
import { workflowRunHandler } from '../../src/tools/workflow-run.js';

test('passes name to daemon.workflowRun and returns wrapped text content', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success', composedPrompt: 'OK' })) };
  const handler = workflowRunHandler(daemon as any);
  const r = await handler({ name: 'demo' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo' });
  expect(JSON.parse(r.content[0].text)).toEqual({ outcome: 'success', composedPrompt: 'OK' });
});
