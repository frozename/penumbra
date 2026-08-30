import { expect, test } from "bun:test";

import { verifyBrainstormFirst } from "@src/gates/brainstorm-first.js";

test("passes when conversation memory shows brainstorming was invoked", () => {
  const r = verifyBrainstormFirst({
    conversationMemory: [
      "user: lets build X",
      "assistant: invoking superpowers:brainstorming",
      "assistant: design approved",
    ],
  });
  expect(r.passed).toBe(true);
});

test("fails when memory has no brainstorm marker", () => {
  const r = verifyBrainstormFirst({
    conversationMemory: ["user: lets build X", "assistant: I will start coding"],
  });
  expect(r.passed).toBe(false);
  expect(r.severity).toBe("advisory");
});

test("passes when no conversation memory provided (gate inert)", () => {
  expect(verifyBrainstormFirst({}).passed).toBe(true);
});
