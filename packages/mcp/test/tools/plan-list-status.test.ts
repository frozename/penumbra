import { expect, test } from 'bun:test';
import { planListHandler } from '../../src/tools/plan-list.js';
import { planStatusHandler } from '../../src/tools/plan-status.js';

test('plan.list returns all plans when no status filter', async () => {
  const daemon = {
    planList: async (req: any) => ({
      plans: [
        { plan_id: 'a-1', file_path: '/a.md', home_project: 'penumbra', registered_at: 1700000000, status: 'running' },
        { plan_id: 'b-2', file_path: '/b.md', home_project: 'sirius', registered_at: 1700000001, status: 'completed' },
      ],
    }),
  };
  const handler = planListHandler(daemon as any);
  const result = await handler({});
  expect(result.content[0].text ? JSON.parse(result.content[0].text) : null).toEqual({
    plans: [
      { plan_id: 'a-1', file_path: '/a.md', home_project: 'penumbra', registered_at: 1700000000, status: 'running' },
      { plan_id: 'b-2', file_path: '/b.md', home_project: 'sirius', registered_at: 1700000001, status: 'completed' },
    ],
  });
});

test('plan.list filters by status', async () => {
  const daemon = {
    planList: async (req: any) => {
      expect(req.status).toBe('running');
      return { plans: [{ plan_id: 'a-1', file_path: '/a.md', home_project: 'penumbra', registered_at: 1700000000, status: 'running' }] };
    },
  };
  const handler = planListHandler(daemon as any);
  const result = await handler({ status: 'running' });
  expect(JSON.parse(result.content[0].text)).toEqual({
    plans: [{ plan_id: 'a-1', file_path: '/a.md', home_project: 'penumbra', registered_at: 1700000000, status: 'running' }],
  });
});

test('plan.list rejects invalid status', async () => {
  const daemon = { planList: async () => ({ plans: [] }) };
  const handler = planListHandler(daemon as any);
  await expect(handler({ status: 'bogus' })).rejects.toThrow();
});

test('plan.status returns plan + hydrated tasks', async () => {
  const daemon = {
    planStatus: async (req: any) => ({
      plan: { plan_id: 'a-1', file_path: '/a.md', home_project: 'penumbra', registered_at: 1700000000, status: 'running' },
      tasks: [
        { plan_id: 'a-1', task_meta_id: '1.1', project_id: 'penumbra', task_id_in_board: 'task-abc', status: 'running', last_event_ts: 1700000005 },
      ],
    }),
  };
  const handler = planStatusHandler(daemon as any);
  const result = await handler({ plan_id: 'a-1' });
  const payload = JSON.parse(result.content[0].text);
  expect(payload.plan.plan_id).toBe('a-1');
  expect(payload.tasks[0].task_id_in_board).toBe('task-abc');
});
