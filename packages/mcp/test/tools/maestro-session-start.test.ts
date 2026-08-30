import type { MaestroSessionRecord } from "@penumbra/core";
import type { DaemonClient } from "@src/daemon-client.js";

import {
  maestroSessionStartHandler,
  MaestroSessionStartInputShape,
} from "@src/tools/maestro-session-start.js";
import { expect, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type MaestroSessionStartFn = DaemonClient["maestroSessionStart"];
type MaestroSessionStartInput = Parameters<MaestroSessionStartFn>[0];

function firstText(content: { type: string; text?: string }[]): string {
  const block = content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected content[0].text");
  }
  return block.text;
}

test("MaestroSessionStartInputShape validates required fields", () => {
  expect(MaestroSessionStartInputShape.task_id.parse("task-1")).toBe("task-1");
  expect(() => MaestroSessionStartInputShape.task_id.parse("")).toThrow();
  expect(() => MaestroSessionStartInputShape.cost_budget_cents.parse(0)).toThrow();
  expect(() => MaestroSessionStartInputShape.sub_dispatch_budget.parse(-1)).toThrow();
});

test("MaestroSessionStartInputShape allows omitted chain_handoff_id", () => {
  expect(() => MaestroSessionStartInputShape.chain_handoff_id.parse(undefined)).not.toThrow();
});

test("maestro_session_start calls daemon and returns created session record", async () => {
  const maestroSessionStart: MaestroSessionStartFn = (
    input: MaestroSessionStartInput,
  ): Promise<MaestroSessionRecord> =>
    Promise.resolve({
      task_id: input.task_id,
      chain_handoff_id: input.chain_handoff_id ?? null,
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
    });
  const handler = maestroSessionStartHandler(fakeDaemon({ maestroSessionStart }));
  const out = await handler({
    task_id: "task-1",
    chain_handoff_id: "handoff-1",
    agent_id: "codex-acp-fast",
    wall_clock_budget_ms: 60_000,
    cost_budget_cents: 100,
    sub_dispatch_budget: 3,
  });
  const payload = JSON.parse(firstText(out.content)) as MaestroSessionRecord;
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
