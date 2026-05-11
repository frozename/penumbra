import { expect, test } from 'bun:test';
import {
  maestroSessionStartAdhocHandler,
  MaestroSessionStartAdhocInputShape,
} from '../../src/tools/maestro-session-start-adhoc.js';

test('MaestroSessionStartAdhocInputShape validates required fields', () => {
  expect((MaestroSessionStartAdhocInputShape as any).message.parse('run one shot')).toBe('run one shot');
  expect(() => (MaestroSessionStartAdhocInputShape as any).message.parse('')).toThrow();
  expect(() => (MaestroSessionStartAdhocInputShape as any).wall_clock_budget_ms.parse(0)).toThrow();
  expect(() => (MaestroSessionStartAdhocInputShape as any).cost_budget_cents.parse(-1)).toThrow();
  expect(() => (MaestroSessionStartAdhocInputShape as any).sub_dispatch_budget.parse(0)).toThrow();
});

test('maestro_session_start_adhoc calls daemon and returns dispatched session payload', async () => {
  const daemon = {
    maestroSessionStartAdhoc: async (input: {
      message: string;
      agent_id: string;
      wall_clock_budget_ms: number;
      cost_budget_cents: number;
      sub_dispatch_budget: number;
      project_id?: string | null;
    }) => ({
      status: 'dispatched',
      agent_name: input.agent_id,
      chain_handoff_id: 'handoff-1',
      conversation_id: 'conv-1',
      session: {
        task_id: 'task-1',
        chain_handoff_id: 'handoff-1',
        agent_id: input.agent_id,
        started_at: 1_746_000_000_000,
        wall_clock_budget_ms: input.wall_clock_budget_ms,
        cost_budget_cents: input.cost_budget_cents,
        sub_dispatch_budget: input.sub_dispatch_budget,
        cost_consumed_cents: 0,
        sub_dispatches_consumed: 0,
        soft_warned_at: null,
        terminated_at: null,
        termination_reason: null,
      },
    }),
  } as any;
  const handler = maestroSessionStartAdhocHandler(daemon);
  const out = await handler({
    message: 'summarize release notes',
    agent_id: 'local-gemma4-26b-a4b-mtp',
    wall_clock_budget_ms: 600_000,
    cost_budget_cents: 50,
    sub_dispatch_budget: 5,
    project_id: 'proj-alpha',
  });
  const payload = JSON.parse((out.content[0] as any).text);
  expect(payload.status).toBe('dispatched');
  expect(payload.agent_name).toBe('local-gemma4-26b-a4b-mtp');
  expect(payload.chain_handoff_id).toBe('handoff-1');
  expect(payload.session.task_id).toBe('task-1');
});
