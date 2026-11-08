import { expect, test } from "bun:test";

import { verifyBrainstormFirst } from "@src/gates/brainstorm-first.js";

test("treats an empty conversation memory array as inert", () => {
  const r = verifyBrainstormFirst({ conversationMemory: [] });
  expect(r.passed).toBe(true);
  expect(r.evidence).toBe("no conversation memory provided; gate inert");
});

test("accepts the invoking-the-brainstorming-skill marker on its own, case-insensitively", () => {
  const r = verifyBrainstormFirst({
    conversationMemory: ["assistant: Invoking the Brainstorming skill"],
  });
  expect(r.passed).toBe(true);
  expect(r.evidence).toBe("brainstorm marker found");
});

test("accepts the design approved marker on its own, case-insensitively", () => {
  const r = verifyBrainstormFirst({ conversationMemory: ["assistant: DESIGN APPROVED"] });
  expect(r.passed).toBe(true);
  expect(r.evidence).toBe("brainstorm marker found");
});

test("accepts a docs/superpowers/specs/ path as a marker", () => {
  const r = verifyBrainstormFirst({
    conversationMemory: ["assistant: wrote docs/superpowers/specs/2026-11-07-x.md"],
  });
  expect(r.passed).toBe(true);
  expect(r.evidence).toBe("brainstorm marker found");
});

test("does not accept a bare brainstorming mention as a marker", () => {
  const r = verifyBrainstormFirst({
    conversationMemory: ["assistant: let's do some brainstorming first"],
  });
  expect(r.passed).toBe(false);
  expect(r.evidence).toBe("no brainstorm marker — implementation without prior brainstorm/spec");
});
