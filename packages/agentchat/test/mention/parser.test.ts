import { parseMentions } from "@src/mention/parser.js";
import { expect, test } from "bun:test";

test("extracts a single @mention at the end of a message", () => {
  expect(parseMentions("Here's the plan. @gemini please run it.")).toEqual([
    { target: "gemini", span: { start: 17, end: 24 } },
  ]);
});

test("extracts multiple @mentions", () => {
  expect(parseMentions("cc @gemini and @codex").map((m) => m.target)).toEqual(["gemini", "codex"]);
});

test("ignores @ inside an email or URL", () => {
  expect(parseMentions("contact alice@example.com or @bob")).toEqual([
    { target: "bob", span: expect.any(Object) as { start: number; end: number } },
  ]);
});

test("returns [] when there is no @mention", () => {
  expect(parseMentions("no targets here")).toEqual([]);
});

test("targets allow letters, digits, dashes, underscores", () => {
  expect(parseMentions("@local-llm and @gpt_4").map((m) => m.target)).toEqual([
    "local-llm",
    "gpt_4",
  ]);
});

test("fallback: extracts known target even if no preceding whitespace", () => {
  expect(parseMentions("PLAN-OK@executor", { knownTargets: ["executor"] })).toEqual([
    { target: "executor", span: { start: 7, end: 16 } },
  ]);
});

test("fallback: does not extract without knownTargets provided", () => {
  expect(parseMentions("PLAN-OK@executor")).toEqual([]);
});

test("fallback: rejects mid-word @ even with known targets (like emails)", () => {
  expect(parseMentions("name@example.com", { knownTargets: ["example"] })).toEqual([]);
});
