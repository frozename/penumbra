import type { MaestroSessionRecord } from "@penumbra/core";

import { expect, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { DaemonHttpError } from "../../src/daemon-client.js";
import {
  maestroSessionGetHandler,
  MaestroSessionGetInputShape,
} from "../../src/tools/maestro-session-get.js";
import { fakeDaemon } from "../helpers.js";

type MaestroSessionGetFn = DaemonClient["maestroSessionGet"];

function firstText(content: { type: string; text?: string }[]): string {
  const block = content[0];
  if (block === undefined || typeof block.text !== "string") {
    throw new Error("expected content[0].text");
  }
  return block.text;
}

test("MaestroSessionGetInputShape requires task_id", () => {
  expect(() => MaestroSessionGetInputShape.task_id.parse(undefined)).toThrow();
  expect(MaestroSessionGetInputShape.task_id.parse("task-1")).toBe("task-1");
});

test("maestro.session_get returns the hydrated record when it exists", async () => {
  const maestroSessionGet: MaestroSessionGetFn = (
    task_id: string,
  ): Promise<MaestroSessionRecord> => {
    expect(task_id).toBe("task-1");
    return Promise.resolve({
      task_id: "task-1",
      chain_handoff_id: "handoff-1",
      agent_id: "codex",
      started_at: 1_746_000_000_000,
      wall_clock_budget_ms: 120_000,
      cost_budget_cents: 80,
      sub_dispatch_budget: 3,
      cost_consumed_cents: 12,
      sub_dispatches_consumed: 1,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
  };
  const handler = maestroSessionGetHandler(fakeDaemon({ maestroSessionGet }));
  const out = await handler({ task_id: "task-1" });
  const payload = JSON.parse(firstText(out.content)) as MaestroSessionRecord;
  expect(payload.task_id).toBe("task-1");
  expect(payload.chain_handoff_id).toBe("handoff-1");
});

test("maestro.session_get returns null for unknown task_id", async () => {
  const maestroSessionGet: MaestroSessionGetFn = (): Promise<MaestroSessionRecord> =>
    Promise.reject(new DaemonHttpError("daemon /maestro/sessions/missing: HTTP 404", 404));
  const handler = maestroSessionGetHandler(fakeDaemon({ maestroSessionGet }));
  const out = await handler({ task_id: "missing" });
  const payload = JSON.parse(firstText(out.content)) as MaestroSessionRecord | null;
  expect(payload).toBeNull();
});
