import { expect, test, vi } from "bun:test";
import { classifyFindings } from "../src/services/memory-efficacy-classifier.js";
import type { Finding } from "../src/services/memory-efficacy-classifier.js";
import type { JudgeChatFn } from "../src/services/judge-chat.js";

test("classifyFindings includes the tight reason cap guidance in the prompt", async () => {
  const judgeChat: JudgeChatFn = vi.fn(async ({ messages }) => {
    const content = messages[0]?.content ?? "";
    expect(content).toContain('reason": "<= 80 chars, fragment, no clauses>"');
    expect(content).toContain("Worked examples (read these first):");
    expect(content).toContain("Example 1 → missed_registration");
    expect(content).toContain("Example 2 → recall_miss");
    expect(content).toContain("Example 3 → memory_ignored");
    expect(content).toContain("Now classify this finding:");
    return JSON.stringify([
      { findingId: "finding-1", classification: "not_memory_related", reason: "stubbed" },
    ]);
  });

  await classifyFindings(
    [{ findingId: "finding-1", severity: "High", text: "Example finding", index: 1 }],
    {
      judgeChat,
      model: "test-model",
    },
  );
});

test("classifyFindings sends findings in batches of five", async () => {
  const calls: number[] = [];
  const judgeChat: JudgeChatFn = vi.fn(async ({ messages }) => {
    const content = messages[0]?.content ?? "";
    const batchSize = content.split("\n").filter((line) => /^finding-\d+\./.test(line)).length;
    calls.push(batchSize);
    return JSON.stringify(
      Array.from({ length: batchSize }, (_, index) => ({
        findingId: `finding-${calls.length}-${index + 1}`,
        classification: "not_memory_related",
        reason: "stubbed",
      })),
    );
  });

  const findings: Finding[] = Array.from({ length: 12 }, (_, index) => ({
    findingId: `finding-${index + 1}`,
    severity: index % 2 === 0 ? "High" : null,
    text: `Finding ${index + 1}`,
    index,
  }));

  const result = await classifyFindings(findings, {
    judgeChat,
    model: "test-model",
  });

  expect(judgeChat).toHaveBeenCalledTimes(3);
  expect(calls).toEqual([5, 5, 2]);
  expect(result).toHaveLength(12);
});

test("classifyFindings handles malformed JSON, throws, and partial batch success", async () => {
  const judgeChat: JudgeChatFn = vi.fn(async ({ messages }) => {
    const content = messages[0]?.content ?? "";
    if (/^finding-1\./m.test(content)) {
      return JSON.stringify([
        { findingId: "finding-1", classification: "recall_miss", reason: "ok" },
        { findingId: "finding-2", classification: "memory_ignored", reason: "ok" },
        { findingId: "finding-3", classification: "not_memory_related", reason: "ok" },
        { findingId: "finding-4", classification: "missed_registration", reason: "ok" },
        { findingId: "finding-5", classification: "recall_miss", reason: "ok" },
      ]);
    }
    if (content.includes("finding-6")) return "not-json";
    throw new Error("boom");
  });

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const findings: Finding[] = Array.from({ length: 10 }, (_, index) => ({
    findingId: `finding-${index + 1}`,
    severity: "High",
    text: `Finding ${index + 1}`,
    index,
  }));

  const result = await classifyFindings(findings, {
    judgeChat,
    model: "test-model",
  });

  expect(result).toHaveLength(5);
  expect(result.map((row) => row.findingId)).toEqual([
    "finding-1",
    "finding-2",
    "finding-3",
    "finding-4",
    "finding-5",
  ]);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
