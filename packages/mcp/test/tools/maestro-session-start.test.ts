import { expect, test } from "bun:test";
import {
  maestroSessionStartHandler,
  MaestroSessionStartInputShape,
} from "../../src/tools/maestro-session-start.js";

test("MaestroSessionStartInputShape validates required fields", () => {
  expect((MaestroSessionStartInputShape as any).task_id.parse("task-1")).toBe("task-1");
  expect(() => (MaestroSessionStartInputShape as any).task_id.parse("")).toThrow();
  expect(() => (MaestroSessionStartInputShape as any).cost_budget_cents.parse(0)).toThrow();
  expect(() => (MaestroSessionStartInputShape as any).sub_dispatch_budget.parse(-1)).toThrow();
});

test("MaestroSessionStartInputShape allows omitted chain_handoff_id", () => {
  expect(() =>
    (MaestroSessionStartInputShape as any).chain_handoff_id.parse(undefined),
  ).not.toThrow();
});

test("maestro_session_start calls daemon and returns created session record", async () => {
  const daemon = {
    maestroSessionStart: async (input: {
      task_id: string;
      chain_handoff_id?: string;
      agent_id: string;
      wall_clock_budget_ms: number;
      cost_budget_cents: number;
      sub_dispatch_budget: number;
    }) => ({
      task_id: input.task_id,
      chain_handoff_id: input.chain_handoff_id,
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
    }),
  } as any;
  const handler = maestroSessionStartHandler(daemon);
  const out = await handler({
    task_id: "task-1",
    chain_handoff_id: "handoff-1",
    agent_id: "codex-acp-fast",
    wall_clock_budget_ms: 60_000,
    cost_budget_cents: 100,
    sub_dispatch_budget: 3,
  });
  const payload = JSON.parse((out.content[0] as any).text);
  expect(payload).toEqual({
    task_id: "task-1",
    chain_handoff_id: "handoff-1",
    agent_id: "codex-acp-fast",
    started_at: 1_746_000_000_000,
    wall_clock_budget_ms: 60_000,
    cost_budget_cents: 100,
    sub_dispatch_budget: 3,
    cost_consumed_cents: 0,
    sub_dispatches_consumed: 0,
    soft_warned_at: null,
    terminated_at: null,
    termination_reason: null,
  });
});
