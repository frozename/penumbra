import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  FEW_SHOT_EXAMPLES,
  REWRITE_RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  type RewriteResponse,
} from "../packages/daemon/src/dreaming/dream-rewriter-prompt-content.js";
import { buildDreamQueryRewritePrompt } from "../packages/daemon/src/dreaming/dream-rewriter-prompt.js";
import { llmInvoke } from "../packages/daemon/src/services/llm-invoke.js";

interface EvalCase {
  id: string;
  title: string;
  body_first_200: string;
  expected_verdict: RewriteResponse["kind"];
}

interface ModelConfig {
  id: string;
  baseUrl: string;
  model: string;
}

type PromptVariant = "current" | "revised";

interface CellResult {
  model_id: string;
  model_name: string;
  variant: PromptVariant;
  case_id: string;
  expected_verdict: RewriteResponse["kind"];
  verdict: RewriteResponse["kind"] | null;
  query_or_reason: string;
  raw: string;
  latency_ms: number;
  error: string | null;
  correct: boolean;
}

const LLAMACTL_PROXY = "http://127.0.0.1:7944";
const MODELS: ModelConfig[] = [
  {
    id: "granite-4.1-3b",
    baseUrl: LLAMACTL_PROXY,
    model: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
  },
  { id: "qwen3.6-35b-a3b", baseUrl: LLAMACTL_PROXY, model: "Qwen3.6-35B-A3B-4bit" },
];

const PROMPT_VARIANTS: readonly PromptVariant[] = ["current", "revised"];

const REVISED_FIRST_SHOT = {
  input: {
    title: "Test-driven development workflow for engine registry",
    body_first_200:
      "Postmortem notes described how we added new registries and kept behavior stable by writing tests first. Team was coordinating API shape, validation order, and migration safety before merge.",
  },
  output: {
    kind: "skip",
    reason:
      "engine registry is internal codebase nomenclature; generic methodology paired with internal-object noun has no public corpus",
  },
} satisfies (typeof FEW_SHOT_EXAMPLES)[number];

const PROJECT_ROOT = process.cwd();
const EVAL_KIND = process.env.REWRITER_BENCH_EVAL ?? "synthetic";
const EVAL_FILENAME =
  EVAL_KIND === "prod" ? "rewriter-eval-prod-2026-05-25.jsonl" : "rewriter-eval-2026-05-25.jsonl";
const OUTPUT_SUFFIX = EVAL_KIND === "prod" ? "-prod" : "";
const EVAL_PATH = join(PROJECT_ROOT, "docs/notes", EVAL_FILENAME);
const MARKDOWN_OUTPUT_PATH = join(
  PROJECT_ROOT,
  `docs/notes/rewriter-bench-2026-05-25${OUTPUT_SUFFIX}.md`,
);
const RAW_OUTPUT_PATH = join(
  PROJECT_ROOT,
  `docs/notes/rewriter-bench-2026-05-25${OUTPUT_SUFFIX}-raw.json`,
);

function buildRevisedPrompt(input: { title: string; bodyFirst200: string }) {
  const examples = [REVISED_FIRST_SHOT, ...FEW_SHOT_EXAMPLES.slice(1)];
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...examples.flatMap((example) => [
      {
        role: "user" as const,
        content: JSON.stringify({
          title: example.input.title,
          body_first_200: example.input.body_first_200,
        }),
      },
      {
        role: "assistant" as const,
        content: JSON.stringify(example.output),
      },
    ]),
    {
      role: "user" as const,
      content: JSON.stringify({ title: input.title, body_first_200: input.bodyFirst200 }),
    },
  ];
}

function buildPrompt(variant: PromptVariant, caseItem: EvalCase) {
  if (variant === "current") {
    return buildDreamQueryRewritePrompt({
      title: caseItem.title,
      bodyFirst200: caseItem.body_first_200,
    });
  }

  return buildRevisedPrompt({
    title: caseItem.title,
    bodyFirst200: caseItem.body_first_200,
  });
}

function loadEvalCases(): EvalCase[] {
  if (!existsSync(EVAL_PATH)) {
    throw new Error(`Eval file not found: ${EVAL_PATH}`);
  }

  const raw = readFileSync(EVAL_PATH, "utf8");
  const cases: EvalCase[] = [];

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${EVAL_PATH} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== "string" ||
      typeof (parsed as { title?: unknown }).title !== "string" ||
      typeof (parsed as { body_first_200?: unknown }).body_first_200 !== "string" ||
      typeof (parsed as { expected_verdict?: unknown }).expected_verdict !== "string"
    ) {
      throw new Error(`Malformed eval row at ${EVAL_PATH} line ${index + 1}`);
    }

    const expected = (parsed as { expected_verdict: string }).expected_verdict;
    if (expected !== "skip" && expected !== "query") {
      throw new Error(`Invalid expected_verdict "${expected}" at ${EVAL_PATH} line ${index + 1}`);
    }

    cases.push({
      id: (parsed as { id: string }).id,
      title: (parsed as { title: string }).title,
      body_first_200: (parsed as { body_first_200: string }).body_first_200,
      expected_verdict: expected,
    });
  }

  return cases;
}

async function runCase(
  model: ModelConfig,
  variant: PromptVariant,
  caseItem: EvalCase,
): Promise<CellResult> {
  const messages = buildPrompt(variant, caseItem);
  const start = performance.now();
  const result = await llmInvoke({
    baseUrl: model.baseUrl,
    model: model.model,
    messages,
    schema: REWRITE_RESPONSE_SCHEMA,
    temperature: 0,
    timeoutMs: 30_000,
  });
  const latency_ms = Math.round(performance.now() - start);

  if (!result.ok) {
    return {
      model_id: model.id,
      model_name: model.id,
      variant,
      case_id: caseItem.id,
      expected_verdict: caseItem.expected_verdict,
      verdict: null,
      query_or_reason: "",
      raw: "",
      latency_ms,
      error: result.reason,
      correct: false,
    };
  }

  const verdict = result.value.kind;
  const queryOrReason = verdict === "query" ? result.value.query : result.value.reason;

  return {
    model_id: model.id,
    model_name: model.id,
    variant,
    case_id: caseItem.id,
    expected_verdict: caseItem.expected_verdict,
    verdict,
    query_or_reason: queryOrReason,
    raw: result.raw,
    latency_ms,
    error: null,
    correct: verdict === caseItem.expected_verdict,
  };
}

function bucketFor(caseItem: EvalCase): "skip" | "query" | "borderline" {
  if (caseItem.id.startsWith("borderline-")) {
    return "borderline";
  }
  if (caseItem.expected_verdict === "query") {
    return "query";
  }
  return "skip";
}

function renderCellResult(expected: RewriteResponse["kind"], result: CellResult): string {
  if (result.error !== null || result.verdict === null) {
    return "⚠️ error";
  }
  return `${result.verdict === expected ? "✅" : "❌"} ${result.verdict}`;
}

function formatPercent(n: number, d: number) {
  if (d === 0) {
    return "0/0";
  }
  return `${n}/${d}`;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function buildMarkdownOutput(results: CellResult[], cases: EvalCase[]): string {
  const now = new Date().toISOString();
  const caseCounts = {
    skip: cases.filter((item) => bucketFor(item) === "skip").length,
    query: cases.filter((item) => bucketFor(item) === "query").length,
    borderline: cases.filter((item) => bucketFor(item) === "borderline").length,
  };

  const summaryRows: string[] = [];
  for (const model of MODELS) {
    for (const variant of PROMPT_VARIANTS) {
      const scoped = results.filter((r) => r.model_id === model.id && r.variant === variant);
      const errors = scoped.filter((item) => item.error !== null).length;
      const skipCases = cases.filter((item) => bucketFor(item) === "skip");
      const queryCases = cases.filter((item) => bucketFor(item) === "query");
      const borderlineCases = cases.filter((item) => bucketFor(item) === "borderline");
      const correctSkip = scoped.filter(
        (item) =>
          cases.find((c) => c.id === item.case_id && bucketFor(c) === "skip")?.id && item.correct,
      ).length;
      const correctQuery = scoped.filter(
        (item) =>
          cases.find((c) => c.id === item.case_id && bucketFor(c) === "query")?.id && item.correct,
      ).length;
      const correctBorderline = scoped.filter(
        (item) =>
          cases.find((c) => c.id === item.case_id && bucketFor(c) === "borderline")?.id &&
          item.correct,
      ).length;
      const correct = scoped.filter((item) => item.correct).length;
      const latency = average(scoped.map((item) => item.latency_ms));

      summaryRows.push(
        `| ${model.id} | ${variant} | ${formatPercent(correct, cases.length)} | ${errors} | ${formatPercent(
          correctSkip,
          skipCases.length,
        )} | ${formatPercent(correctQuery, queryCases.length)} | ${formatPercent(
          correctBorderline,
          borderlineCases.length,
        )} | ${latency} |`,
      );
    }
  }

  const perCaseSections = PROMPT_VARIANTS.map((variant) => {
    const lines = [
      `## Per-case results (${variant} prompt)`,
      "",
      "| Case ID | Expected | granite-4.1-3b | qwen3.6-35b-a3b |",
      "|---|---|---|---|",
    ];
    for (const caseItem of cases) {
      const byModel = (modelId: string) =>
        results.find(
          (r) => r.case_id === caseItem.id && r.model_id === modelId && r.variant === variant,
        );

      const granite = byModel("granite-4.1-3b");
      const qwen = byModel("qwen3.6-35b-a3b");

      lines.push(
        `| ${caseItem.id} | ${caseItem.expected_verdict} | ${
          granite ? renderCellResult(caseItem.expected_verdict, granite) : "n/a"
        } | ${qwen ? renderCellResult(caseItem.expected_verdict, qwen) : "n/a"} |`,
      );
    }
    return lines.join("\n");
  });

  const disagreementRows = results.filter(
    (r) => r.error !== null || r.verdict !== r.expected_verdict,
  );
  const disagreementsHeader = ["## Disagreements with expected", ""];
  if (disagreementRows.length === 0) {
    disagreementsHeader.push("No disagreements against expected.");
  } else {
    const byCase = new Map<string, CellResult[]>();
    for (const row of disagreementRows) {
      const existing = byCase.get(row.case_id);
      if (existing) {
        existing.push(row);
      } else {
        byCase.set(row.case_id, [row]);
      }
    }

    for (const [caseId, rows] of byCase) {
      const expected = cases.find((item) => item.id === caseId)?.expected_verdict ?? "unknown";
      disagreementsHeader.push(`### ${caseId}`);
      disagreementsHeader.push(`- expected: ${expected}`);
      for (const row of rows) {
        disagreementsHeader.push(`- ${row.model_id} (${row.variant}):`);
        disagreementsHeader.push(`  - verdict: ${row.verdict ?? "error"}`);
        disagreementsHeader.push(`  - query_or_reason: ${row.query_or_reason || "(empty)"}`);
        if (row.error !== null) {
          disagreementsHeader.push(`  - error: ${row.error}`);
        }
        disagreementsHeader.push("  - raw:");
        disagreementsHeader.push("    ```text");
        disagreementsHeader.push(row.raw ? row.raw : "(no raw output)");
        disagreementsHeader.push("    ```");
      }
      disagreementsHeader.push("");
    }
  }

  return [
    "# Rewriter A/B benchmark — 2026-05-25",
    "",
    `Run: ${now}`,
    `Eval cases: ${cases.length} (${caseCounts.skip} skip / ${caseCounts.query} query / ${caseCounts.borderline} borderline)`,
    "",
    "## Summary",
    "",
    "| Model | Prompt | Correct | Errors | Skip accuracy | Query accuracy | Borderline correct | Avg latency (ms) |",
    "|---|---|---|---|---|---|---|---|",
    ...summaryRows,
    "",
    perCaseSections[0],
    "",
    perCaseSections[1],
    "",
    ...disagreementsHeader,
    "",
  ].join("\n");
}

async function runSmokeCheck(cases: EvalCase[]) {
  const smokeCase =
    cases.find((item) => item.id === "skip-code-identifier") ??
    cases.find((item) => item.expected_verdict === "skip");
  if (!smokeCase) {
    throw new Error("No skip-class case available for smoke test");
  }
  const result = await runCase(MODELS[0], "current", smokeCase);
  if (result.error !== null || result.verdict !== "skip") {
    throw new Error(
      `Smoke test failed for ${smokeCase.id} on ${MODELS[0].id}: verdict=${result.verdict ?? "error"}, error=${
        result.error ?? "none"
      }`,
    );
  }
}

async function main() {
  const cases = loadEvalCases();
  await runSmokeCheck(cases);

  const allResults: CellResult[] = [];

  for (const model of MODELS) {
    for (const variant of PROMPT_VARIANTS) {
      console.log(`model=${model.id} variant=${variant} start`);
      for (const caseItem of cases) {
        allResults.push(await runCase(model, variant, caseItem));
      }
    }
  }

  const markdown = buildMarkdownOutput(allResults, cases);
  writeFileSync(MARKDOWN_OUTPUT_PATH, markdown);
  writeFileSync(RAW_OUTPUT_PATH, JSON.stringify(allResults, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
