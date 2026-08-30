import { buildNextPrompt } from "@src/cli/transcript.js";
import { expect, test } from "bun:test";

test("empty transcript + wrapper only returns just the wrapper", () => {
  const result = buildNextPrompt([], "sender", "hello there", { maxTokens: 100 });
  expect(result).toBe("From @sender: hello there");
});

test("one user entry + wrapper", () => {
  const result = buildNextPrompt(
    [{ agent: "user", text: "do the thing" }],
    "planner",
    "i plan to do it",
    { maxTokens: 100 },
  );
  expect(result).toBe("[user]: do the thing\n\nFrom @planner: i plan to do it");
});

test("multi-entry transcript orders oldest-first, wrapper at end", () => {
  const transcript = [
    { agent: "user", text: "start" },
    { agent: "planner", text: "step 1" },
  ];
  const result = buildNextPrompt(transcript, "executor", "done step 1", { maxTokens: 100 });
  expect(result).toBe("[user]: start\n\n[planner]: step 1\n\nFrom @executor: done step 1");
});

test("over-budget transcript drops oldest blocks, wrapper preserved", () => {
  const transcript = [
    { agent: "user", text: "a very long user message here" }, // ~7 tokens
    { agent: "planner", text: "short plan" }, // ~2 tokens
  ];
  // 1 token ~ 4 chars.
  // '[user]: a very long user message here\n\n' = 39 chars (~9.75 tokens)
  // '[planner]: short plan\n\n' = 23 chars (~5.75 tokens)
  // 'From @executor: ok' = 18 chars (~4.5 tokens)
  // total approx 20 tokens. Let's budget 12 tokens. Should drop the user message.
  const result = buildNextPrompt(transcript, "executor", "ok", { maxTokens: 12 });
  expect(result).toBe("[planner]: short plan\n\nFrom @executor: ok");
});

test("wrapper alone exceeds budget is returned as-is", () => {
  const transcript = [{ agent: "user", text: "start" }];
  const result = buildNextPrompt(
    transcript,
    "executor",
    "a very long reply that exceeds budget alone",
    { maxTokens: 5 },
  );
  expect(result).toBe("From @executor: a very long reply that exceeds budget alone");
});

test("projectContext is prepended as a # Project context section", () => {
  const result = buildNextPrompt([{ agent: "user", text: "do thing" }], "planner", "plan ready", {
    maxTokens: 200,
    projectContext: "Repo: foo\nPrimary lang: TypeScript",
  });
  expect(result).toBe(
    "# Project context\nRepo: foo\nPrimary lang: TypeScript\n\n" +
      "[user]: do thing\n\n" +
      "From @planner: plan ready",
  );
});

test("projectContext is preserved when transcript blocks are budget-trimmed", () => {
  const ctx = "Repo: foo"; // 9 chars
  const transcript = [
    { agent: "user", text: "a very long user message here" }, // [user]: ... → 38 chars → ~9.5 tokens
    { agent: "planner", text: "short plan" }, // [planner]: short plan → 21 chars → ~5.25 tokens
  ];
  // Total with context+wrapper at full transcript >> budget; trim should drop user, keep planner+ctx+wrapper.
  const result = buildNextPrompt(transcript, "executor", "ok", {
    maxTokens: 18,
    projectContext: ctx,
  });
  expect(result.startsWith("# Project context\nRepo: foo\n\n")).toBe(true);
  expect(result.includes("[user]:")).toBe(false);
  expect(result.endsWith("From @executor: ok")).toBe(true);
});

test("empty projectContext is treated as if absent", () => {
  const result = buildNextPrompt([{ agent: "user", text: "hi" }], "planner", "ok", {
    maxTokens: 100,
    projectContext: "",
  });
  expect(result).toBe("[user]: hi\n\nFrom @planner: ok");
});
