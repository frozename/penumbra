import { expect, mock, test } from 'bun:test';
import { DaemonHttpError } from '../../src/daemon-client.js';
import { brainstormHandler } from '../../src/tools/brainstorm.js';

test('brainstorm proxies to workflowRun with workflow name and args', async () => {
  const daemon = {
    workflowRun: mock(async () => ({ outcome: 'success', run_id: 'wf-1' })),
  };
  const handler = brainstormHandler(daemon as any);
  const out = await handler({ topic: 'Improve dispatch reliability', constraints: 'No daemon schema changes' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({
    name: 'brainstorm',
    wait: true,
    args: {
      topic: 'Improve dispatch reliability',
      constraints: 'No daemon schema changes',
    },
  });
  expect(JSON.parse(out.content[0].text)).toEqual({ outcome: 'success', run_id: 'wf-1' });
});

test('brainstorm returns structured workflow_missing error when brainstorm workflow is absent', async () => {
  const daemon = {
    workflowRun: mock(async () => {
      throw new DaemonHttpError('daemon /workflows/run: HTTP 404', 404, {
        error: { code: 'not_found', message: 'workflow brainstorm not found' },
      });
    }),
  };
  const handler = brainstormHandler(daemon as any);
  const out = await handler({ topic: 'Find alternatives' });
  expect(JSON.parse(out.content[0].text)).toEqual({
    error: {
      code: 'workflow_missing',
      workflow: 'brainstorm',
      message: 'workflow brainstorm is not registered',
    },
  });
});
