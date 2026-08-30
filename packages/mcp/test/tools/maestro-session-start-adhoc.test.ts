import type { DaemonClient } from "@src/daemon-client.js";

import {
  maestroSessionStartAdhocHandler,
  MaestroSessionStartAdhocInputShape,
} from "@src/tools/maestro-session-start-adhoc.js";
import { expect, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type MaestroSessionStartAdhocFn = DaemonClient["maestroSessionStartAdhoc"];
type MaestroSessionStartAdhocInput = Parameters<MaestroSessionStartAdhocFn>[0];
type MaestroSessionStartAdhocResult = Awaited<ReturnType<MaestroSessionStartAdhocFn>>;

function firstText(content: { type: string; text?: string }[]): string {
  const block = content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected content[0].text");
  }
  return block.text;
}

test("MaestroSessionStartAdhocInputShape validates required fields", () => {
  expect(MaestroSessionStartAdhocInputShape.message.parse("run one shot")).toBe("run one shot");
  expect(() => MaestroSessionStartAdhocInputShape.message.parse("")).toThrow();
  expect(() => MaestroSessionStartAdhocInputShape.wall_clock_budget_ms.parse(0)).toThrow();
  expect(() => MaestroSessionStartAdhocInputShape.cost_budget_cents.parse(-1)).toThrow();
  expect(() => MaestroSessionStartAdhocInputShape.sub_dispatch_budget.parse(0)).toThrow();
});

test("maestro_session_start_adhoc calls daemon and returns dispatched session payload", async () => {
  const maestroSessionStartAdhoc: MaestroSessionStartAdhocFn = (
    input: MaestroSessionStartAdhocInput,
  ): Promise<MaestroSessionStartAdhocResult> =>
    Promise.resolve({
      status: "dispatched",
      agent_name: input.agent_id,
      chain_handoff_id: "handoff-1",
      conversation_id: "conv-1",
      session: {
        task_id: "task-1",
        chain_handoff_id: "handoff-1",
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
    });
  const handler = maestroSessionStartAdhocHandler(fakeDaemon({ maestroSessionStartAdhoc }));
  const out = await handler({
    message: "summarize release notes",
    agent_id: "local-gemma4-26b-a4b-mtp",
    wall_clock_budget_ms: 600_000,
    cost_budget_cents: 50,
    sub_dispatch_budget: 5,
    project_id: "proj-alpha",
  });
  const payload = JSON.parse(firstText(out.content)) as MaestroSessionStartAdhocResult;
  expect(payload.status).toBe("dispatched");
  expect(payload.agent_name).toBe("local-gemma4-26b-a4b-mtp");
  expect(payload.chain_handoff_id).toBe("handoff-1");
  expect(payload.session.task_id).toBe("task-1");
});
