import { expect, test } from "bun:test";
import { DaemonHttpError } from "../../src/daemon-client.js";
import {
  maestroSessionGetHandler,
  MaestroSessionGetInputShape,
} from "../../src/tools/maestro-session-get.js";

test("MaestroSessionGetInputShape requires task_id", () => {
  expect(() => (MaestroSessionGetInputShape as any).task_id.parse(undefined)).toThrow();
  expect((MaestroSessionGetInputShape as any).task_id.parse("task-1")).toBe("task-1");
});

test("maestro.session_get returns the hydrated record when it exists", async () => {
  const daemon = {
    maestroSessionGet: async (task_id: string) => {
      expect(task_id).toBe("task-1");
      return {
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
      };
    },
  } as any;
  const handler = maestroSessionGetHandler(daemon);
  const out = await handler({ task_id: "task-1" });
  const payload = JSON.parse((out.content[0] as any).text);
  expect(payload.task_id).toBe("task-1");
  expect(payload.chain_handoff_id).toBe("handoff-1");
});

test("maestro.session_get returns null for unknown task_id", async () => {
  const daemon = {
    maestroSessionGet: async () => {
      throw new DaemonHttpError("daemon /maestro/sessions/missing: HTTP 404", 404);
    },
  } as any;
  const handler = maestroSessionGetHandler(daemon);
  const out = await handler({ task_id: "missing" });
  const payload = JSON.parse((out.content[0] as any).text);
  expect(payload).toBeNull();
});
