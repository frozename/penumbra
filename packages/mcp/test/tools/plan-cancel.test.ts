import { expect, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { DaemonHttpError } from "../../src/daemon-client.js";
import { planCancelHandler } from "../../src/tools/plan-cancel.js";
import { fakeDaemon } from "../helpers.js";

type PlanCancelFn = DaemonClient["planCancel"];
type PlanCancelReq = Parameters<PlanCancelFn>[0];
type PlanCancelResult = Awaited<ReturnType<PlanCancelFn>>;

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("plan.cancel happy path returns plan_id + cancelled status", async () => {
  const planCancel: PlanCancelFn = (req: PlanCancelReq): Promise<PlanCancelResult> =>
    Promise.resolve({
      plan_id: req.plan_id,
      status: "cancelled",
      cancelled_running_count: 2,
    });
  const handler = planCancelHandler(fakeDaemon({ planCancel }));
  const result = await handler({ plan_id: "abc-1700000000" });
  expect(result.plan_id).toBe("abc-1700000000");
  expect(result.status).toBe("cancelled");
});

test("plan.cancel translates 404 into a not found error", async () => {
  const planCancel: PlanCancelFn = (): Promise<PlanCancelResult> => {
    throw new DaemonHttpError("daemon /plans/cancel: HTTP 404", 404, {
      error: { code: "plan_not_found", message: "plan not found" },
    });
  };
  const handler = planCancelHandler(fakeDaemon({ planCancel }));
  const err = await captureRejection(handler({ plan_id: "abc" }));
  const message = err instanceof Error ? err.message : String(err);
  expect(message).toMatch(/plan\.cancel plan not found: abc/);
});
