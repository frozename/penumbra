import { expect, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { planStartHandler } from "@src/tools/plan-start.js";

import { fakeDaemon } from "../helpers.js";

type PlanStartFn = DaemonClient["planStart"];
type PlanStartResult = Awaited<ReturnType<PlanStartFn>>;

function firstJson(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("plan.start happy path returns plan_id + status", async () => {
  const planStart: PlanStartFn = (): Promise<PlanStartResult> =>
    Promise.resolve({ plan_id: "abc-123-1700000000", status: "running" });
  const handler = planStartHandler(fakeDaemon({ planStart }));
  const result = await handler({ file_path: "/tmp/plan.md" });
  expect(firstJson(result)).toEqual({ plan_id: "abc-123-1700000000", status: "running" });
});

test("plan.start surfaces validation_failed details", async () => {
  const planStart: PlanStartFn = (): Promise<PlanStartResult> => {
    throw new DaemonHttpError("daemon /plans: HTTP 400", 400, {
      error: "validation_failed",
      details: [{ task_id: "1.1", rule: "unknown_project", message: "unknown project foo" }],
    });
  };
  const handler = planStartHandler(fakeDaemon({ planStart }));
  const err1 = await captureRejection(handler({ file_path: "/tmp/plan.md" }));
  const msg1 = err1 instanceof Error ? err1.message : String(err1);
  expect(msg1).toMatch(/validation_failed/);
  const err2 = await captureRejection(handler({ file_path: "/tmp/plan.md" }));
  const msg2 = err2 instanceof Error ? err2.message : String(err2);
  expect(msg2).toMatch(/unknown project foo/);
});
