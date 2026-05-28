import { expect, test } from "bun:test";
import { type Clock, systemClock } from "../../src/utils/clock.js";

test("systemClock returns a Date within 100ms of now", () => {
  const before = Date.now();
  const d = systemClock();
  const after = Date.now();
  expect(d.getTime()).toBeGreaterThanOrEqual(before);
  expect(d.getTime()).toBeLessThanOrEqual(after + 100);
});

test("Clock type is a zero-arg function returning Date", () => {
  const fixed: Clock = () => new Date("2026-04-23T12:00:00Z");
  expect(fixed().toISOString()).toBe("2026-04-23T12:00:00.000Z");
});
