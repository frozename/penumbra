import { expect, test, vi } from "bun:test";

import type { JudgeChatFn } from "../src/services/judge-chat.js";
import type { Finding } from "../src/services/memory-efficacy-classifier.js";

import {
  classifyFindings,
  MEMORY_EFFICACY_BUCKETS,
} from "../src/services/memory-efficacy-classifier.js";

test("classifyFindings includes the tight reason cap guidance in the prompt", async () => {
  const impl: JudgeChatFn = (opts) => {
    const content = opts.messages[0]?.content ?? "";
    expect(content).toContain('reason": "<= 80 chars, fragment, no clauses>"');
    expect(content).toContain("Worked examples (read these first):");
    expect(content).toContain("Example 1 → missed_registration");
    expect(content).toContain("Example 2 → recall_miss");
    expect(content).toContain("Example 3 → memory_ignored");
    expect(content).toContain("Now classify this finding:");
    return Promise.resolve(
      JSON.stringify([
        { findingId: "finding-1", classification: "not_memory_related", reason: "stubbed" },
      ]),
    );
  };
  const judgeChat = vi.fn(impl);

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
  const impl: JudgeChatFn = (opts) => {
    const content = opts.messages[0]?.content ?? "";
    const batchSize = content.split("\n").filter((line) => /^finding-\d+\./.test(line)).length;
    calls.push(batchSize);
    return Promise.resolve(
      JSON.stringify(
        Array.from({ length: batchSize }, (_, index) => ({
          findingId: `finding-${String(calls.length)}-${String(index + 1)}`,
          classification: "not_memory_related",
          reason: "stubbed",
        })),
      ),
    );
  };
  const judgeChat = vi.fn(impl);

  const findings: Finding[] = Array.from({ length: 12 }, (_, index) => ({
    findingId: `finding-${String(index + 1)}`,
    severity: index % 2 === 0 ? "High" : null,
    text: `Finding ${String(index + 1)}`,
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
  const impl: JudgeChatFn = (opts) => {
    const content = opts.messages[0]?.content ?? "";
    if (/^finding-1\./m.test(content)) {
      return Promise.resolve(
        JSON.stringify([
          { findingId: "finding-1", classification: "recall_miss", reason: "ok" },
          { findingId: "finding-2", classification: "memory_ignored", reason: "ok" },
          { findingId: "finding-3", classification: "not_memory_related", reason: "ok" },
          { findingId: "finding-4", classification: "missed_registration", reason: "ok" },
          { findingId: "finding-5", classification: "recall_miss", reason: "ok" },
        ]),
      );
    }
    if (content.includes("finding-6")) return Promise.resolve("not-json");
    throw new Error("boom");
  };
  const judgeChat = vi.fn(impl);

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {
    /* suppress noise */
  });
  const findings: Finding[] = Array.from({ length: 10 }, (_, index) => ({
    findingId: `finding-${String(index + 1)}`,
    severity: "High",
    text: `Finding ${String(index + 1)}`,
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

test("MEMORY_EFFICACY_BUCKETS pins the four labels and an unknown classification drops the batch", async () => {
  expect(MEMORY_EFFICACY_BUCKETS).toEqual([
    "missed_registration",
    "recall_miss",
    "memory_ignored",
    "not_memory_related",
  ]);

  const impl: JudgeChatFn = () =>
    Promise.resolve(
      JSON.stringify([
        { findingId: "finding-1", classification: "other_bucket", reason: "stubbed" },
      ]),
    );
  const judgeChat = vi.fn(impl);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {
    /* suppress noise */
  });

  const result = await classifyFindings(
    [{ findingId: "finding-1", severity: "High", text: "Example finding", index: 1 }],
    {
      judgeChat,
      model: "test-model",
    },
  );

  expect(result).toEqual([]);
  warn.mockRestore();
});
