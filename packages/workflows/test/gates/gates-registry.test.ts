import { expect, test } from "bun:test";

import {
  GATES,
  verifyBrainstormFirst,
  verifyTdd,
  verifyVerificationBeforeComplete,
  verifyWorktreeIsolation,
} from "@src/gates/index.js";

test("registers exactly the four gate names", () => {
  expect(Object.keys(GATES).sort()).toEqual([
    "brainstorm-first",
    "tdd",
    "verification-before-complete",
    "worktree-isolation",
  ]);
});

test("maps each gate name to its verifier", () => {
  expect(GATES.tdd).toBe(verifyTdd);
  expect(GATES["brainstorm-first"]).toBe(verifyBrainstormFirst);
  expect(GATES["verification-before-complete"]).toBe(verifyVerificationBeforeComplete);
  expect(GATES["worktree-isolation"]).toBe(verifyWorktreeIsolation);
});
