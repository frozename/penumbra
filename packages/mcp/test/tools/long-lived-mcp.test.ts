import { expect, mock, test } from 'bun:test';
import {
  longLivedListHandler,
  LongLivedListInputShape,
} from '../../src/tools/long-lived-list-mcp.js';
import { longLivedGetHandler } from '../../src/tools/long-lived-get-mcp.js';
import { longLivedPauseHandler } from '../../src/tools/long-lived-pause-mcp.js';
import { longLivedResumeHandler } from '../../src/tools/long-lived-resume-mcp.js';
import { longLivedRetireHandler } from '../../src/tools/long-lived-retire-mcp.js';
import { longLivedStateGetHandler } from '../../src/tools/long-lived-state-get-mcp.js';
import { longLivedStateSetHandler } from '../../src/tools/long-lived-state-set-mcp.js';
import { longLivedPendingActionsHandler } from '../../src/tools/long-lived-pending-actions-mcp.js';
import { LongLivedPendingActionsInputShape } from '../../src/tools/long-lived-pending-actions-mcp.js';
import { longLivedApproveActionHandler } from '../../src/tools/long-lived-approve-action-mcp.js';
import { longLivedRejectActionHandler } from '../../src/tools/long-lived-reject-action-mcp.js';
import { longLivedInjectGoalHandler } from '../../src/tools/long-lived-inject-goal-mcp.js';
import { longLivedAuditHandler } from '../../src/tools/long-lived-audit-mcp.js';
import { longLivedTicksHandler } from '../../src/tools/long-lived-ticks-mcp.js';

test('long_lived_list proxies to daemon.longLivedList', async () => {
  const daemon = { longLivedList: mock().mockResolvedValue({ agents: [{ id: 'a' }] }) } as any;
  const result = await longLivedListHandler(daemon)();
  expect(daemon.longLivedList).toHaveBeenCalledTimes(1);
  expect(result.content[0].text).toContain('"agents"');
});

test('long_lived_get proxies to daemon.longLivedGet', async () => {
  const daemon = { longLivedGet: mock().mockResolvedValue({ agent: { id: 'a' } }) } as any;
  await longLivedGetHandler(daemon)({ id: 'a' });
  expect(daemon.longLivedGet).toHaveBeenCalledWith('a');
});

test('long_lived_pause proxies to daemon.longLivedPause', async () => {
  const daemon = { longLivedPause: mock().mockResolvedValue({ id: 'a', status: 'paused' }) } as any;
  await longLivedPauseHandler(daemon)({ id: 'a' });
  expect(daemon.longLivedPause).toHaveBeenCalledWith('a');
});

test('long_lived_resume proxies to daemon.longLivedResume', async () => {
  const daemon = { longLivedResume: mock().mockResolvedValue({ id: 'a', status: 'active' }) } as any;
  await longLivedResumeHandler(daemon)({ id: 'a' });
  expect(daemon.longLivedResume).toHaveBeenCalledWith('a');
});

test('long_lived_retire proxies to daemon.longLivedRetire', async () => {
  const daemon = { longLivedRetire: mock().mockResolvedValue({ id: 'a', status: 'retired' }) } as any;
  await longLivedRetireHandler(daemon)({ id: 'a' });
  expect(daemon.longLivedRetire).toHaveBeenCalledWith('a');
});

test('long_lived_state_get proxies to daemon.longLivedStateGet', async () => {
  const daemon = { longLivedStateGet: mock().mockResolvedValue({ working_memory: {} }) } as any;
  await longLivedStateGetHandler(daemon)({ id: 'a' });
  expect(daemon.longLivedStateGet).toHaveBeenCalledWith('a');
});

test('long_lived_state_set proxies to daemon.longLivedStateSet', async () => {
  const daemon = { longLivedStateSet: mock().mockResolvedValue({ ok: true }) } as any;
  await longLivedStateSetHandler(daemon)({ id: 'a', partial: { intent_summary: 'x' } });
  expect(daemon.longLivedStateSet).toHaveBeenCalledWith('a', { intent_summary: 'x' });
});

test('long_lived_pending_actions proxies to daemon.longLivedPendingActions', async () => {
  const daemon = { longLivedPendingActions: mock().mockResolvedValue({ pending_actions: [] }) } as any;
  await longLivedPendingActionsHandler(daemon)({ id: 'a', status: 'pending' });
  expect(daemon.longLivedPendingActions).toHaveBeenCalledWith('a', 'pending');
});

test('long_lived_pending_actions requires id', () => {
  expect(LongLivedPendingActionsInputShape.id.safeParse(undefined).success).toBe(false);
});

test('long_lived_approve_action proxies to daemon.longLivedApproveAction', async () => {
  const daemon = { longLivedApproveAction: mock().mockResolvedValue({ ok: true }) } as any;
  await longLivedApproveActionHandler(daemon)({ action_id: 'x' });
  expect(daemon.longLivedApproveAction).toHaveBeenCalledWith('x', undefined);
});

test('long_lived_approve_action forwards decided_by', async () => {
  const daemon = { longLivedApproveAction: mock().mockResolvedValue({ ok: true }) } as any;
  await longLivedApproveActionHandler(daemon)({ action_id: 'x', decided_by: 'maestro:foo' } as any);
  expect(daemon.longLivedApproveAction).toHaveBeenCalledWith('x', 'maestro:foo');
});

test('long_lived_reject_action proxies to daemon.longLivedRejectAction', async () => {
  const daemon = { longLivedRejectAction: mock().mockResolvedValue({ ok: true }) } as any;
  await longLivedRejectActionHandler(daemon)({ action_id: 'x', reason: 'no' });
  expect(daemon.longLivedRejectAction).toHaveBeenCalledWith('x', 'no', undefined);
});

test('long_lived_reject_action forwards decided_by and reason', async () => {
  const daemon = { longLivedRejectAction: mock().mockResolvedValue({ ok: true }) } as any;
  await longLivedRejectActionHandler(daemon)({ action_id: 'x', reason: 'no', decided_by: 'maestro:foo' } as any);
  expect(daemon.longLivedRejectAction).toHaveBeenCalledWith('x', 'no', 'maestro:foo');
});

test('long_lived_inject_goal proxies to daemon.longLivedInjectGoal', async () => {
  const daemon = { longLivedInjectGoal: mock().mockResolvedValue({ ok: true }) } as any;
  await longLivedInjectGoalHandler(daemon)({ id: 'a', goal: 'do thing' });
  expect(daemon.longLivedInjectGoal).toHaveBeenCalledWith('a', 'do thing');
});

test('long_lived_audit proxies to daemon.longLivedAudit', async () => {
  const daemon = { longLivedAudit: mock().mockResolvedValue({ audit: [] }) } as any;
  await longLivedAuditHandler(daemon)({ id: 'a', since: 10, limit: 5 });
  expect(daemon.longLivedAudit).toHaveBeenCalledWith('a', 10, 5);
});

test('long_lived_ticks proxies to daemon.longLivedTicks', async () => {
  const daemon = { longLivedTicks: mock().mockResolvedValue({ ticks: [] }) } as any;
  await longLivedTicksHandler(daemon)({ id: 'a', since: 10, limit: 5 });
  expect(daemon.longLivedTicks).toHaveBeenCalledWith('a', 10, 5);
});
