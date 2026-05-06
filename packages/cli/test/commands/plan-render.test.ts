import { expect, test } from 'bun:test';
import { renderPlanTree } from '../../src/commands/plan-render.js';

test('renders 3-task fixture in deterministic order', () => {
  const out = renderPlanTree({
    plan: { plan_id: 'abc-1700', home_project: 'penumbra', status: 'running', registered_at: 1700000000 },
    tasks: [
      { task_meta_id: '1.3', project_id: 'penumbra', task_id_in_board: null, status: 'pending' },
      { task_meta_id: '1.1', project_id: 'penumbra', task_id_in_board: 'task-abc', status: 'completed' },
      { task_meta_id: '1.2', project_id: 'sirius', task_id_in_board: 'task-def', status: 'running' },
    ],
  });
  expect(out).toBe([
    'plan abc-1700 (status: running)',
    '  [completed] 1.1 · project=penumbra · board=task-abc',
    '  [running] 1.2 · project=sirius · board=task-def',
    '  [pending] 1.3 · project=penumbra · board=-',
  ].join('\n'));
});

test('handles empty tasks list', () => {
  const out = renderPlanTree({
    plan: { plan_id: 'empty', home_project: 'penumbra', status: 'running' },
    tasks: [],
  });
  expect(out).toBe('plan empty (status: running)');
});
