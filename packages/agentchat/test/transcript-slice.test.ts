import { expect, test } from "bun:test";
import { buildPrompt } from "../src/transcript-slice.js";

test("buildPrompt concatenates project context, handoff message, and recent responses", () => {
  const out = buildPrompt({
    projectContext: "# Project\nthe rate-limiter component",
    handoffMessage: "@executor please run the plan",
    recentResponses: [{ agent: "claude", text: "Here's the plan: 1) add middleware…" }],
    tokenBudget: 4096,
  });
  expect(out).toContain("# Project");
  expect(out).toContain("Here's the plan");
  expect(out).toContain("@executor please run the plan");
  // handoff message must appear last (most recent context)
  expect(out.lastIndexOf("@executor")).toBeGreaterThan(out.lastIndexOf("Here's the plan"));
});

test("buildPrompt drops oldest responses when over the token budget", () => {
  const big = "x".repeat(4000);
  const out = buildPrompt({
    projectContext: "",
    handoffMessage: "go",
    recentResponses: [
      { agent: "a", text: big },
      { agent: "b", text: big },
      { agent: "c", text: "recent" },
    ],
    tokenBudget: 1500, // ~6000 chars at 4 chars/token
  });
  expect(out).toContain("recent");
  expect(out).toContain("go");
  // expect the oldest to have been trimmed
  expect((out.match(/x{4000}/g) ?? []).length).toBeLessThan(2);
});

test("buildPrompt handles empty inputs gracefully", () => {
  const out = buildPrompt({
    projectContext: "",
    handoffMessage: "",
    recentResponses: [],
    tokenBudget: 1000,
  });
  expect(typeof out).toBe("string");
});
