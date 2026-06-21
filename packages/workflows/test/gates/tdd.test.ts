import { expect, test } from "bun:test";

import { verifyTdd } from "../../src/gates/tdd.js";

test("passes on bun test output with pass count", () => {
  const r = verifyTdd({ dispatchResult: { stdout: "bun test v1.3.13\n12 pass\n0 fail\n" } });
  expect(r.passed).toBe(true);
});

test("fails when dispatch result has no test output marker", () => {
  const r = verifyTdd({ dispatchResult: { stdout: "I implemented the feature." } });
  expect(r.passed).toBe(false);
  expect(r.severity).toBe("triggers-retry");
});

test("fails when test output shows failures", () => {
  const r = verifyTdd({ dispatchResult: { stdout: "bun test v1.3.13\n1 pass\n3 fail\n" } });
  expect(r.passed).toBe(false);
  expect(r.evidence).toContain("3 fail");
});

test("passes if no dispatchResult provided (gate inert in non-dispatch context)", () => {
  expect(verifyTdd({}).passed).toBe(true);
});
