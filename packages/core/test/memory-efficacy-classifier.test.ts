import { expect, test, vi } from "bun:test";

import type { JudgeChatFn } from "../src/services/judge-chat.js";
import type { Finding } from "../src/services/memory-efficacy-classifier.js";

import {
  classifyFindings,
  MEMORY_EFFICACY_BUCKET_DEFINITIONS,
  MEMORY_EFFICACY_BUCKETS,
} from "../src/services/memory-efficacy-classifier.js";

const SINGLE_FINDING: Finding[] = [
  { findingId: "finding-1", severity: "High", text: "Example finding", index: 1 },
];

async function capturePrompt(findings: Finding[]): Promise<string> {
  let captured = "";
  const impl: JudgeChatFn = (opts) => {
    captured = opts.messages[0]?.content ?? "";
    return Promise.resolve("[]");
  };
  await classifyFindings(findings, { judgeChat: vi.fn(impl), model: "test-model" });
  return captured;
}

interface WorkedExample {
  label: string;
  finding: string;
  classification: string;
  reason: string;
}

function parseWorkedExamples(prompt: string): WorkedExample[] {
  const section = prompt.split("Worked examples (read these first):")[1] ?? "";
  const examples: WorkedExample[] = [];
  for (const match of section.matchAll(/Example \d+ → (\w+)\nFinding: ([^\n]+)\n(\{[^\n]+\})/g)) {
    const [, label, finding, json] = match;
    if (label === undefined || finding === undefined || json === undefined) continue;
    const payload = JSON.parse(json) as { classification: string; reason: string };
    examples.push({
      label,
      finding,
      classification: payload.classification,
      reason: payload.reason,
    });
  }
  return examples;
}

test("classifyFindings includes the tight reason cap guidance in the prompt", async () => {
  const prompt = await capturePrompt(SINGLE_FINDING);
  expect(prompt).toContain('reason": "<= 80 chars, fragment, no clauses>"');
  expect(prompt).toContain("Worked examples (read these first):");
  expect(prompt).toContain("Now classify these findings:");
  expect(prompt).not.toContain("Now classify this finding:");
});

test("MEMORY_EFFICACY_BUCKET_DEFINITIONS is exported and embedded verbatim in the prompt", async () => {
  const index = await import("@penumbra/core");
  expect(index.MEMORY_EFFICACY_BUCKET_DEFINITIONS).toBe(MEMORY_EFFICACY_BUCKET_DEFINITIONS);
  expect(Object.keys(MEMORY_EFFICACY_BUCKET_DEFINITIONS).sort()).toEqual(
    [...MEMORY_EFFICACY_BUCKETS].sort(),
  );

  const prompt = await capturePrompt(SINGLE_FINDING);
  for (const bucket of MEMORY_EFFICACY_BUCKETS) {
    expect(prompt).toContain(MEMORY_EFFICACY_BUCKET_DEFINITIONS[bucket]);
  }
});

test("prompt states the not_memory_related default and the code-defect and recall-facts rules", async () => {
  const prompt = await capturePrompt(SINGLE_FINDING);
  expect(prompt).toContain("not_memory_related is the default");
  expect(prompt).toContain("memory subsystem's own code");
  expect(prompt).toContain("is a code defect and is not_memory_related");
  expect(prompt).toContain("never answer recall_miss or memory_ignored");
});

test("worked examples never label memory-subsystem code defects as memory failures", async () => {
  const prompt = await capturePrompt(SINGLE_FINDING);
  const examples = parseWorkedExamples(prompt);
  expect(examples.length).toBeGreaterThanOrEqual(4);
  for (const example of examples) {
    expect(example.classification).toBe(example.label);
  }

  const negatives = examples.filter((e) => e.label === "not_memory_related");
  expect(negatives.length).toBeGreaterThanOrEqual(3);

  const memorySubsystemCode = /ingest|rank|recall|inject/i;
  for (const example of examples) {
    if (memorySubsystemCode.test(example.finding)) {
      expect(example.label).toBe("not_memory_related");
    }
  }

  const positives = examples.filter((e) => e.label !== "not_memory_related");
  expect(positives.length).toBeLessThanOrEqual(1);
});

test("every worked-example reason is at most 80 characters", async () => {
  const prompt = await capturePrompt(SINGLE_FINDING);
  const examples = parseWorkedExamples(prompt);
  expect(examples.length).toBeGreaterThan(0);
  for (const example of examples) {
    expect(example.reason.length).toBeLessThanOrEqual(80);
  }
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

  const result = await classifyFindings(SINGLE_FINDING, {
    judgeChat,
    model: "test-model",
  });

  expect(result).toEqual([]);
  warn.mockRestore();
});
