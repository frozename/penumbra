import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { workflowRunHandler, WorkflowCwdRequiredError } from '../../src/tools/workflow-run.js';

const originalEnv = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
beforeEach(() => {
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = originalEnv;
});

test('passes name to daemon.workflowRun and returns wrapped text content', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success', composedPrompt: 'OK' })) };
  const handler = workflowRunHandler(daemon as any);
  const r = await handler({ name: 'demo' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo' });
  expect(JSON.parse(r.content[0].text)).toEqual({ outcome: 'success', composedPrompt: 'OK' });
});

test('forwards wait:true to daemon.workflowRun', async () => {
  const daemon = { workflowRun: mock(async () => ({ workflow_run_id: 'wf-1', started_at: 123 })) };
  const handler = workflowRunHandler(daemon as any);
  await handler({ name: 'demo', wait: true });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo', wait: true });
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

test('fills cwd from handler opts when caller omits cwd, with resolution_warning', async () => {
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any, { resolveCwd: () => '/some/path' });
  await handler({ name: 'demo' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({
    name: 'demo',
    cwd: '/some/path',
    resolution_warning: 'workflow_cwd_inferred_from_mcp_cwd',
  });
});

test('throws WorkflowCwdRequiredError when env gate set and cwd omitted', async () => {
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any, { resolveCwd: () => '/daemon/cwd' });
  await expect(handler({ name: 'demo' })).rejects.toBeInstanceOf(WorkflowCwdRequiredError);
  expect(daemon.workflowRun).not.toHaveBeenCalled();
});

test('env gate accepts true/yes/on values', async () => {
  for (const v of ['true', 'yes', 'on']) {
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = v;
    const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
    const handler = workflowRunHandler(daemon as any, { resolveCwd: () => '/daemon/cwd' });
    await expect(handler({ name: 'demo' })).rejects.toBeInstanceOf(WorkflowCwdRequiredError);
  }
});

test('env gate does NOT fire when caller passes explicit cwd', async () => {
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const daemon = { workflowRun: mock(async () => ({ outcome: 'success' })) };
  const handler = workflowRunHandler(daemon as any, { resolveCwd: () => '/daemon/cwd' });
  await handler({ name: 'demo', cwd: '/caller/cwd' });
  expect(daemon.workflowRun).toHaveBeenCalledWith({ name: 'demo', cwd: '/caller/cwd' });
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
