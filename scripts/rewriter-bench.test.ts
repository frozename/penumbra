import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessRewrite,
  parseBenchArgs,
  parseBenchCases,
  parseBenchConfig,
  readResponseMetadata,
  runBenchmark,
  runCase,
} from "./rewriter-bench.js";

const model = {
  id: "test",
  baseUrl: "http://127.0.0.1:18945/v1",
  model: "test-model",
  maxTokens: 512,
  timeoutMs: 30000,
};
const input = {
  id: "case-1",
  title: "SQLite checkpoint starvation with long readers",
  body_first_200: "Readers keep a WAL checkpoint from advancing.",
  expected_verdict: "query" as const,
};
const fakeFetch = (content: string, status = 200): typeof fetch =>
  Object.assign(
    (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            model: "test-model",
            choices: [{ finish_reason: "stop", message: { content } }],
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
      ),
    { preconnect: fetch.preconnect },
  );

test("CLI requires explicit live opt-in, fixtures/config and an output destination", () => {
  expect(() => parseBenchArgs([])).toThrow();
  expect(() => parseBenchArgs(["--config", "c", "--fixtures", "f", "--out", "o"])).toThrow();
  expect(() =>
    parseBenchArgs(["--live", "--config", "c", "--fixtures", "f", "--out", "o", "--typo"]),
  ).toThrow();
  expect(parseBenchArgs(["--live", "--config", "c", "--fixtures", "f", "--out", "o"])).toEqual({
    configPath: "c",
    fixturesPath: "f",
    outDir: "o",
  });
});

test("benchmark configuration cannot silently use hosted origins, URL credentials or unbounded budgets", () => {
  expect(parseBenchConfig({ models: [model] }).models).toHaveLength(1);
  for (const patch of [
    { baseUrl: "https://example.com/v1" },
    { baseUrl: "http://user:password@127.0.0.1/v1" },
    { baseUrl: "http://127.0.0.1/v1?token=secret" },
    { timeoutMs: 30001 },
    { maxTokens: 100000 },
  ])
    expect(() => parseBenchConfig({ models: [{ ...model, ...patch }] })).toThrow();
});

test("fixture validation preserves uncertainty and SQLite Unicode-character excerpt semantics", () => {
  expect(
    parseBenchCases(
      JSON.stringify({ ...input, body_first_200: "😀".repeat(200), expected_verdict: "uncertain" }),
    )[0]?.expected_verdict,
  ).toBe("uncertain");
  expect(() =>
    parseBenchCases(JSON.stringify({ ...input, body_first_200: "😀".repeat(201) })),
  ).toThrow();
  expect(() => parseBenchCases(JSON.stringify({ ...input, expected_verdict: "maybe" }))).toThrow();
  expect(() =>
    parseBenchCases([JSON.stringify(input), JSON.stringify(input)].join("\n")),
  ).toThrow();
});

test("strict output audit exposes extra fields even when the incumbent Zod parser strips them", () => {
  const value = { kind: "query" as const, query: "SQLite WAL checkpoint starvation long readers" };
  expect(assessRewrite(value, JSON.stringify(value)).issues).toEqual([]);
  expect(assessRewrite(value, JSON.stringify({ ...value, confidence: 1 })).issues).toContain(
    "extra_fields",
  );
  expect(assessRewrite(value, "```json\n" + JSON.stringify(value) + "\n```").issues).toContain(
    "not_strict_json",
  );
});

test("query word/format checks are distinct from the real deterministic searchability gate", () => {
  const short = { kind: "query" as const, query: "SQLite WAL" };
  expect(assessRewrite(short, JSON.stringify(short)).issues).toContain("word_count");
  const privateQuery = {
    kind: "query" as const,
    query: "penumbra dispatch_land source handler routing semantics",
  };
  expect(assessRewrite(privateQuery, JSON.stringify(privateQuery)).productionGatePass).toBe(false);
  const quoted = {
    kind: "query" as const,
    query: 'SQLite WAL "checkpoint starvation" long readers',
  };
  expect(assessRewrite(quoted, JSON.stringify(quoted)).issues).toContain("quotes_or_markdown");
  expect(
    assessRewrite(
      { kind: "skip", reason: "line one\nline two" },
      '{"kind":"skip","reason":"line one\\nline two"}',
    ).issues,
  ).toContain("multiline_reason");
});

test("case invocation sends only title/excerpt and never the expected label or source metadata", async () => {
  let captured: unknown;
  const transport: typeof fetch = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof init?.body !== "string") throw new Error("test expects JSON request body");
      captured = JSON.parse(init.body) as unknown;
      return await fakeFetch(
        '{"kind":"query","query":"SQLite WAL checkpoint starvation long readers"}',
      )(_url, init);
    },
    { preconnect: fetch.preconnect },
  );
  const result = await runCase(model, input, transport);
  expect(result.verdict).toBe("query");
  expect(result.correct).toBe(true);
  const body = captured as { messages: { content: string }[] };
  expect(JSON.parse(body.messages.at(-1)?.content ?? "null")).toEqual({
    title: input.title,
    body_first_200: input.body_first_200,
  });
});

test("transport/schema failures remain explicit errors and preserve deterministic title fallback observation", async () => {
  const result = await runCase(model, input, fakeFetch("{}", 503));
  expect(result.error).toBe("http_error");
  expect(result.verdict).toBeNull();
  expect(result.correct).toBe(false);
  expect(result.gate_eligible_text).toBe(input.title);
  const malformed = await runCase(model, input, fakeFetch('{"kind":"query"}'));
  expect(malformed.error).toBe("schema_violation");
  expect(malformed.verdict).toBeNull();
});

test("valid skip has no fallback query, and uncertain cases never receive a fabricated correctness label", async () => {
  const skipped = await runCase(
    model,
    input,
    fakeFetch('{"kind":"skip","reason":"internal only"}'),
  );
  expect(skipped.gate_eligible_text).toBeNull();
  expect(skipped.error).toBeNull();
  const uncertain = await runCase(
    model,
    { ...input, expected_verdict: "uncertain" },
    fakeFetch('{"kind":"skip","reason":"ambiguous"}'),
  );
  expect(uncertain.correct).toBeNull();
});

test("oversized telemetry cloning never deadlocks the original response branch", async () => {
  const original = new Response("x".repeat(140000));
  const observed = await Promise.race([
    readResponseMetadata(original.clone()),
    new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve("deadlocked");
      }, 500),
    ),
  ]);
  expect(observed).toBeNull();
  expect((await original.text()).length).toBe(140000);
});

test("existing output directories are rejected before any inference or overwrites", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penumbra-rewriter-existing-"));
  try {
    writeFileSync(join(directory, "run.json"), "preserved evidence");
    let rejected = false;
    try {
      await runBenchmark(parseBenchConfig({ models: [model] }), [input], directory, "hash");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(readFileSync(join(directory, "run.json"), "utf8")).toBe("preserved evidence");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
