import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BenchTask } from "./bench-prompts.js";

import { gradeSchemaTask, runGrade } from "./bench-grade.js";

interface ChatCompletionRequestBody {
  messages: { content: string }[];
}

interface JudgeChoice {
  message: { content: string };
}

function makeJudgeResponse(choices: JudgeChoice[]): Response {
  return new Response(JSON.stringify({ choices }), {
    headers: { "content-type": "application/json" },
  });
}

// Bun's `typeof fetch` includes a `preconnect` method that plain function
// literals do not satisfy. Tests provide a fetch implementation that only
// services request/response, so widen via a single documented cast helper.
type MinimalFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function asFetch(fn: MinimalFetch): typeof fetch {
  return fn as unknown as typeof fetch;
}

test("runGrade: parses JSONL and dispatches grading prompts to mock HTTP", async () => {
  const jsonlPath = "test-bench-results.jsonl";
  const testEntries = [
    { task: "T4", answer: "4", model: "test-model", label: "test-run" },
    { task: "T5", answer: "blocks in queue", model: "test-model", label: "test-run" },
    { task: "T6", answer: "NO_BUGS", model: "test-model", label: "test-run" },
    { task: "T7", answer: "2", model: "test-model", label: "test-run" },
    { task: "T8", answer: "both", model: "test-model", label: "test-run" },
  ];
  writeFileSync(jsonlPath, testEntries.map((e) => JSON.stringify(e)).join("\n"));

  let callCount = 0;
  const fetchImpl = asFetch(async (input, init): Promise<Response> => {
    callCount++;
    const req = input instanceof Request ? input : new Request(String(input), init);
    const body = (await req.json()) as ChatCompletionRequestBody;
    expect(body.messages.at(0)?.content).toContain("GROUND TRUTH:");
    expect(body.messages.at(0)?.content).toContain("MODEL ANSWER:");

    return makeJudgeResponse([{ message: { content: "PASS" } }]);
  });

  try {
    const url = `http://stub/v1`;
    const results = await runGrade({
      inputPath: jsonlPath,
      url,
      model: "judge-model",
      fetch: fetchImpl,
    });

    expect(results.length).toBe(5);
    expect(callCount).toBe(5);
    for (const r of results) {
      expect(r.verdict).toBe("PASS");
      expect(r.model).toBe("test-model");
      expect(r.label).toBe("test-run");
    }
  } finally {
    rmSync(jsonlPath);
  }
});

test("runGrade: handles PARTIAL and FAIL verdicts correctly", async () => {
  const jsonlPath = "test-bench-mixed.jsonl";
  writeFileSync(jsonlPath, JSON.stringify({ task: "T4", answer: "maybe", model: "m", label: "l" }));

  let call = 0;
  const fetchImpl = asFetch((): Promise<Response> => {
    call++;
    const content = call === 1 ? "PARTIAL verdict" : "totally WRONG";
    return Promise.resolve(makeJudgeResponse([{ message: { content } }]));
  });

  try {
    const url = `http://stub/v1`;
    const results = await runGrade({ inputPath: jsonlPath, url, model: "j", fetch: fetchImpl });
    const [result] = results;
    expect(result?.verdict).toBe("PARTIAL");
  } finally {
    rmSync(jsonlPath);
  }
});

test("gradeResults: short-circuits empty answers and errors before judge", async () => {
  const jsonlDir = mkdtempSync(join(tmpdir(), "bench-grade-"));
  const jsonlPath = join(jsonlDir, "results.jsonl");
  writeFileSync(
    jsonlPath,
    [
      JSON.stringify({ task: "T4", answer: "   ", model: "m", label: "l" }),
      JSON.stringify({ task: "T5", answer: "ok", error: "timeout", model: "m", label: "l" }),
    ].join("\n"),
  );

  const fetchImpl = asFetch((): Promise<Response> => {
    throw new Error("judge should not be called for empty/error results");
  });

  try {
    const results = await runGrade({
      inputPath: jsonlPath,
      url: "http://stub/v1",
      model: "judge",
      fetch: fetchImpl,
    });

    expect(results).toEqual([
      { task: "T4", verdict: "FAIL", model: "m", label: "l" },
      { task: "T5", verdict: "FAIL", model: "m", label: "l" },
    ]);
  } finally {
    rmSync(jsonlDir, { recursive: true, force: true });
  }
});

test("gradeSchemaTask: rejects malformed JSON", () => {
  const task: BenchTask = {
    id: "T9",
    description: "json extraction",
    fixturePath: "x",
    fixtureLabel: "x",
    question: "x",
    maxTokens: 1,
    groundTruth: "x",
    schema: "T2MemoryExtraction[]",
  };

  const result = gradeSchemaTask(task, "{not json");
  expect(result.verdict).toBe("FAIL");
  expect(result.detail).toContain("malformed JSON");
});

test("gradeSchemaTask: rejects schema violations", () => {
  const task: BenchTask = {
    id: "T9",
    description: "json extraction",
    fixturePath: "x",
    fixtureLabel: "x",
    question: "x",
    maxTokens: 1,
    groundTruth: "x",
    schema: "T2MemoryExtraction[]",
  };

  const result = gradeSchemaTask(task, '[{"title":"a","body":"b"}]');
  expect(result.verdict).toBe("FAIL");
  expect(result.detail).toContain("schema violation");
});

test("gradeSchemaTask: passes when all expected extractions are present", () => {
  const task: BenchTask = {
    id: "T9",
    description: "json extraction",
    fixturePath: "x",
    fixtureLabel: "x",
    question: "x",
    maxTokens: 1,
    groundTruth: "x",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [
      { title_substr: "Postgres", body_substr: "audit", kind: "decision" },
      { title_substr: "write", body_substr: "50", kind: "fact" },
    ],
  };

  expect(
    gradeSchemaTask(
      task,
      '[{"title":"Postgres","body":"audit log","kind":"decision"},{"title":"write rate","body":"50/sec","kind":"fact"}]',
    ),
  ).toEqual({ verdict: "PASS", detail: "2/2 matched" });
});

test("gradeSchemaTask: returns partial when only some expected extractions are present", () => {
  const task: BenchTask = {
    id: "T9",
    description: "json extraction",
    fixturePath: "x",
    fixtureLabel: "x",
    question: "x",
    maxTokens: 1,
    groundTruth: "x",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [
      { title_substr: "Postgres", body_substr: "audit", kind: "decision" },
      { title_substr: "write", body_substr: "50", kind: "fact" },
    ],
  };

  expect(
    gradeSchemaTask(task, '[{"title":"Postgres","body":"audit log","kind":"decision"}]'),
  ).toEqual({ verdict: "PARTIAL", detail: "1/2 matched" });
});

test("gradeSchemaTask: passes empty expected and empty actual", () => {
  const task: BenchTask = {
    id: "T11",
    description: "json extraction",
    fixturePath: "x",
    fixtureLabel: "x",
    question: "x",
    maxTokens: 1,
    groundTruth: "x",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [],
  };

  expect(gradeSchemaTask(task, "[]")).toEqual({ verdict: "PASS", detail: "empty as expected" });
});

test("gradeSchemaTask: fails empty expected with non-empty actual", () => {
  const task: BenchTask = {
    id: "T11",
    description: "json extraction",
    fixturePath: "x",
    fixtureLabel: "x",
    question: "x",
    maxTokens: 1,
    groundTruth: "x",
    schema: "T2MemoryExtraction[]",
    expected_extractions: [],
  };

  expect(gradeSchemaTask(task, '[{"title":"hi","body":"there","kind":"fact"}]')).toEqual({
    verdict: "FAIL",
    detail: "expected empty, got 1 extractions",
  });
});
