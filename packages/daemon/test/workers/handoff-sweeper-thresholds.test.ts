import { expect, test } from "bun:test";

import {
  MIN_DISPATCHED_TTL_MS,
  resolveDispatchedTtlMs,
  resolvePendingTtlMs,
} from "@src/workers/handoff-sweeper-thresholds.js";

test.each([null, undefined, "", "not_a_class"])(
  "resolveDispatchedTtlMs(%p) falls back to the 30-minute default",
  (taskType) => {
    expect(resolveDispatchedTtlMs(taskType)).toBe(1_800_000);
  },
);

test.each([
  ["review_adversarial", 2_700_000],
  ["implement_substantial", 3_600_000],
  ["implement_small", 1_800_000],
  ["plan_refine", 2_700_000],
  ["docs_mechanical", 1_200_000],
  ["debug_diagnose", 2_700_000],
  ["smoke_test", 600_000],
  ["health_check", 300_000],
] as const)("resolveDispatchedTtlMs(%s) is %i ms", (taskType, expectedMs) => {
  expect(resolveDispatchedTtlMs(taskType)).toBe(expectedMs);
});

test("MIN_DISPATCHED_TTL_MS is the health_check 5-minute floor", () => {
  expect(MIN_DISPATCHED_TTL_MS).toBe(300_000);
});

test("resolvePendingTtlMs is the 60-minute default", () => {
  expect(resolvePendingTtlMs()).toBe(3_600_000);
});
