import { expect, test } from "bun:test";
import { DaemonHttpError } from "../../src/daemon-client.js";
import { planCancelHandler } from "../../src/tools/plan-cancel.js";

test("plan.cancel happy path returns plan_id + cancelled status", async () => {
  const daemon = {
    planCancel: async (req: any) => ({
      plan_id: req.plan_id,
      status: "cancelled",
      cancelled_running_count: 2,
    }),
  };
  const handler = planCancelHandler(daemon as any);
  const result = await handler({ plan_id: "abc-1700000000" });
  expect(result.plan_id).toBe("abc-1700000000");
  expect(result.status).toBe("cancelled");
});

test("plan.cancel translates 404 into a not found error", async () => {
  const daemon = {
    planCancel: async (req: any) => {
      throw new DaemonHttpError("daemon /plans/cancel: HTTP 404", 404, {
        error: { code: "plan_not_found", message: "plan not found" },
      });
    },
  };
  const handler = planCancelHandler(daemon as any);
  await expect(handler({ plan_id: "abc" })).rejects.toThrow(/plan\.cancel plan not found: abc/);
});
