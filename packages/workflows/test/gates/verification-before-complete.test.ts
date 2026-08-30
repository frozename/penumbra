import { expect, test } from "bun:test";

import { verifyVerificationBeforeComplete } from "@src/gates/verification-before-complete.js";

test("passes when result text shows run-and-saw evidence", () => {
  const r = verifyVerificationBeforeComplete({
    text: "I ran `bun test packages/foo` and saw `12 pass, 0 fail`. Done.",
  });
  expect(r.passed).toBe(true);
});

test("fails when result text claims done without evidence", () => {
  const r = verifyVerificationBeforeComplete({
    text: "I think this works. Marking complete.",
  });
  expect(r.passed).toBe(false);
  expect(r.evidence).toContain("think");
});

test("passes on empty / non-completion text (gate is opt-in)", () => {
  expect(verifyVerificationBeforeComplete({ text: "" }).passed).toBe(true);
  expect(verifyVerificationBeforeComplete({ text: "Doing some intermediate work." }).passed).toBe(
    true,
  );
});
