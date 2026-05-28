import { expect, test } from "bun:test";
import { derivePlanId } from "../../src/plans/plan-id.js";

test("identical inputs collide", () => {
  const a = derivePlanId("plan content", 1_700_000_000_000);
  const b = derivePlanId("plan content", 1_700_000_000_000);
  expect(a).toBe(b);
});

test("different registeredAt yields different id", () => {
  const a = derivePlanId("plan content", 1_700_000_000_000);
  const b = derivePlanId("plan content", 1_700_000_001_000);
  expect(a).not.toBe(b);
});

test("different bytes yields different id", () => {
  const a = derivePlanId("plan content A", 1_700_000_000_000);
  const b = derivePlanId("plan content B", 1_700_000_000_000);
  expect(a).not.toBe(b);
});

test("format is <sha-prefix-12>-<unix-seconds>", () => {
  const id = derivePlanId("hello", 1_700_000_000_000);
  expect(id).toMatch(/^[0-9a-f]{12}-\d+$/);
});

test("accepts Buffer / Uint8Array / string interchangeably", () => {
  const a = derivePlanId("hello", 1_700_000_000_000);
  const b = derivePlanId(Buffer.from("hello", "utf8"), 1_700_000_000_000);
  const c = derivePlanId(new Uint8Array(Buffer.from("hello", "utf8")), 1_700_000_000_000);
  expect(a).toBe(b);
  expect(b).toBe(c);
});
