import { expect, test } from "bun:test";

import { healthRoute } from "@src/routes/health.js";

test("healthRoute omits t2Promotion when no status is supplied", async () => {
  const payload = (await healthRoute().json()) as Record<string, unknown>;

  expect(payload.status).toBe("ok");
  expect(payload.t2Promotion).toBeUndefined();
});

test("healthRoute reports the disabled t2 promotion worker with the judge env name", async () => {
  const payload = (await healthRoute({
    t2Promotion: {
      enabled: false,
      reason: "judge_unconfigured",
      judge_env: "PENUMBRA_JUDGE_BASE_URL",
    },
  }).json()) as Record<string, unknown>;

  expect(payload.t2Promotion).toEqual({
    enabled: false,
    reason: "judge_unconfigured",
    judge_env: "PENUMBRA_JUDGE_BASE_URL",
  });
});

test("healthRoute reports an enabled t2 promotion worker", async () => {
  const payload = (await healthRoute({
    t2Promotion: {
      enabled: true,
      reason: "judge_configured",
      judge_env: "PENUMBRA_JUDGE_BASE_URL",
    },
  }).json()) as Record<string, unknown>;

  expect(payload.t2Promotion).toEqual({
    enabled: true,
    reason: "judge_configured",
    judge_env: "PENUMBRA_JUDGE_BASE_URL",
  });
});
