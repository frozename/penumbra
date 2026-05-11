import { expect, mock, test } from 'bun:test';
import { workflowRunHandler } from '../../src/tools/workflow-run.js';

test('passes name to daemon.workflowRun and returns wrapped text content', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success', composedPrompt: 'OK' })) };
  const handler = workflowRunHandler(daemon as any);
  const r = await handler({ name: 'demo' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo' });
  expect(JSON.parse(r.content[0].text)).toEqual({ outcome: 'success', composedPrompt: 'OK' });
});

test('forwards optional session_id and cwd to daemon.workflowRun', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any);
  await handler({ name: 'demo', cwd: '/tmp/demo', session_id: 'sess-123' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo', cwd: '/tmp/demo', session_id: 'sess-123' });
});

test('forwards optional args to daemon.workflowRun', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any);
  await handler({ name: 'demo', args: { base_ref: 'main', target_ref: 'HEAD' } });
  expect(daemon.workflowRun).toHaveBeenCalledWith({
    name: 'demo',
    args: { base_ref: 'main', target_ref: 'HEAD' },
  });
});

test('fills cwd from handler opts when caller omits cwd', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any, { resolveCwd: () => '/some/path' });
  await handler({ name: 'demo' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo', cwd: '/some/path' });
});

test('keeps caller cwd when provided', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any, { resolveCwd: () => '/some/path' });
  await handler({ name: 'demo', cwd: '/caller/path' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo', cwd: '/caller/path' });
});

test('leaves cwd unset when no opts are provided', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any);
  await handler({ name: 'demo' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo' });
});
