import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import type {
  SystemOneWireAnswer,
  TypesafeFetch,
  TypesafeQuestion,
} from "../packages/integrations/typesafe/src/index.js";

import {
  buildDreamingPromptBlock,
  parseDreamingJudgeResponse,
} from "../packages/daemon/src/dreaming/dreaming-judge-pool.js";
import {
  buildEfficacyQuestions,
  buildTaskProfileQuestions,
  createLocalDecisionClient,
  derivePromoteProbability,
  LOCAL_PROMOTION_QUESTIONS,
  PROMOTION_QUESTION_IDS,
} from "../packages/integrations/typesafe/src/index.js";
import {
  binaryMetrics,
  type BinarySample,
  categoricalMetrics,
  percentile,
  selectThreshold,
} from "./system-one-judge-metrics.js";

export const fixtureSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  split: z.enum(["calibration", "test"]),
  workload: z.enum(["promotion", "efficacy", "task-profile"]),
  state: z.record(z.string(), z.unknown()),
  labels: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])),
  labelRationale: z.string().min(1),
  labeler: z.string().min(1),
  labelStatus: z.enum(["provisional-single-annotator", "independently-adjudicated"]),
  source: z.object({
    kind: z.enum(["synthetic", "historical"]),
    table: z.string().optional(),
    id: z.string().optional(),
    sha256: z.string().optional(),
  }),
  tags: z.array(z.string()),
});
export type JudgeFixture = z.infer<typeof fixtureSchema>;
export const benchConfigSchema = z.object({
  protocol: z.enum(["systemone", "incumbent-promotion", "constrained-promotion"]),
  promotionQuestionSet: z.enum(["all", "direct"]).default("all"),
  baseUrl: z.url(),
  model: z.string().min(1),
  revision: z.string().min(1),
  hardware: z.string().min(1),
  runtime: z.string().min(1),
  quantization: z.string().min(1),
  contextTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive().default(10_000),
  maxRequestBytes: z.number().int().positive().default(100_000),
  allowRemote: z.boolean().default(false),
});
export type JudgeBenchConfig = z.input<typeof benchConfigSchema>;
export interface BenchRow {
  caseId: string;
  iteration: number;
  inputSha256: string;
  model: string;
  revision: string;
  mode: "shadow";
  applied: false;
  latencyMs: number;
  startedOffsetMs?: number;
  error: string | null;
  answers: Record<string, SystemOneWireAnswer>;
  usage: { inputTokens: number; outputTokens: number } | null;
  probabilitySource: "native" | "self-reported-confidence";
  incumbentDecision?: boolean;
}
export interface BenchOutput {
  schemaVersion: 1;
  status: "not_run" | "executed";
  config: JudgeBenchConfig;
  startedAt: string;
  elapsedMs: number;
  concurrency: number;
  repeats: number;
  fixtureSha256: string;
  rows: BenchRow[];
}
export interface BenchDeps {
  live: boolean;
  fetch: TypesafeFetch;
  concurrency?: number;
  repeats?: number;
}

export function questionsFor(fixture: JudgeFixture): Record<string, TypesafeQuestion> {
  if (fixture.workload === "efficacy") return buildEfficacyQuestions();
  if (fixture.workload === "task-profile") return buildTaskProfileQuestions();
  return LOCAL_PROMOTION_QUESTIONS;
}
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateFixtures(fixtures: JudgeFixture[]): void {
  const ids = new Set<string>();
  const families = new Map<string, string>();
  const inputs = new Map<string, string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture: ${fixture.id}`);
    ids.add(fixture.id);
    for (const [map, key] of [
      [families, fixture.family],
      [inputs, digest(fixture.state)],
    ] as const) {
      if (map.has(key) && map.get(key) !== fixture.split)
        throw new Error("family or duplicate input crosses split");
      map.set(key, fixture.split);
    }
  }
}

export async function runJudgeBench(
  rawConfig: JudgeBenchConfig,
  fixtures: JudgeFixture[],
  deps: BenchDeps,
): Promise<BenchOutput> {
  const config = benchConfigSchema.parse(rawConfig);
  validateFixtures(fixtures);
  const concurrency = deps.concurrency ?? 1;
  const repeats = deps.repeats ?? 1;
  if (
    ![concurrency, repeats].every((n) => Number.isSafeInteger(n) && n >= 1) ||
    concurrency > 8 ||
    repeats > 100
  )
    throw new Error("invalid concurrency or repeats");
  const rows: BenchRow[] = [];
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const client = createLocalDecisionClient({
    ...config,
    fetch: deps.fetch,
    maxConcurrency: concurrency,
    maxRetries: 0,
  });
  const evaluate = async (fixture: JudgeFixture, iteration: number): Promise<void> => {
    const start = performance.now();
    const questions =
      fixture.workload === "promotion" && config.promotionQuestionSet === "direct"
        ? { promote: LOCAL_PROMOTION_QUESTIONS.promote }
        : questionsFor(fixture);
    const row: BenchRow = {
      caseId: fixture.id,
      iteration,
      inputSha256: digest({ state: fixture.state, questions: questionsFor(fixture) }),
      model: config.model,
      revision: config.revision,
      mode: "shadow",
      applied: false,
      latencyMs: 0,
      startedOffsetMs: start - started,
      answers: {},
      usage: null,
      error: null,
      probabilitySource: config.protocol === "systemone" ? "native" : "self-reported-confidence",
    };
    if (config.protocol !== "systemone") {
      await incumbent(fixture, row, config, deps.fetch);
    } else {
      const outcome = await client.evaluate({
        state: fixture.state,
        questions,
      });
      if (!outcome.ok) row.error = outcome.kind;
      else {
        row.answers = outcome.answers;
        row.usage = outcome.usage;
      }
    }
    if (
      fixture.workload === "promotion" &&
      PROMOTION_QUESTION_IDS.every((id) => row.answers[id]?.type === "noul")
    ) {
      const answers = Object.fromEntries(
        PROMOTION_QUESTION_IDS.map((id) => [id, (row.answers[id] as { noul: number }).noul]),
      );
      const score = derivePromoteProbability(
        answers as Parameters<typeof derivePromoteProbability>[0],
      );
      row.answers.filtered_promote = { type: "noul", noul: score };
    }
    row.latencyMs = performance.now() - start;
    rows.push(row);
  };
  if (deps.live) {
    const jobs = Array.from({ length: repeats }, (_, iteration) =>
      fixtures.map((fixture) => ({ fixture, iteration })),
    ).flat();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const job = jobs[cursor++];
          if (!job) return;
          await evaluate(job.fixture, job.iteration);
        }
      }),
    );
  }
  rows.sort((a, b) => a.iteration - b.iteration || a.caseId.localeCompare(b.caseId));
  return {
    schemaVersion: 1,
    status: deps.live ? "executed" : "not_run",
    config,
    concurrency,
    repeats,
    startedAt,
    elapsedMs: performance.now() - started,
    fixtureSha256: digest(fixtures),
    rows,
  };
}

async function incumbent(
  fixture: JudgeFixture,
  row: BenchRow,
  config: z.output<typeof benchConfigSchema>,
  fetch: TypesafeFetch,
): Promise<void> {
  if (fixture.workload !== "promotion") {
    row.error = "unsupported";
    return;
  }
  try {
    const response = await fetch(`${new URL(config.baseUrl).origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify({
        model: config.model,
        messages:
          config.protocol === "constrained-promotion"
            ? [
                {
                  role: "system",
                  content: `${LOCAL_PROMOTION_QUESTIONS.promote.instructions} Return ONLY valid JSON: {"promote": <boolean>, "confidence": <number 0.0-1.0 expressing confidence in your chosen answer>}. Do not generate a rationale.`,
                },
                { role: "user", content: JSON.stringify(fixture.state) },
              ]
            : [
                {
                  role: "user",
                  content: buildDreamingPromptBlock({
                    body: String(fixture.state.body),
                    kind: "promote_t1",
                  }),
                },
              ],
        response_format: { type: "json_object" },
        max_tokens: config.protocol === "constrained-promotion" ? 64 : 256,
        temperature: 0,
      }),
    });
    if (!response.ok) {
      row.error = `http_${String(response.status)}`;
      return;
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const parsed = parseDreamingJudgeResponse(data.choices?.[0]?.message?.content ?? "");
    if (parsed.unparseable || data.choices?.[0]?.finish_reason === "length") {
      row.error = "invalid_response";
      return;
    }
    row.answers.promote = {
      type: "noul",
      noul: parsed.promote ? parsed.confidence : 1 - parsed.confidence,
    };
    row.incumbentDecision = parsed.promote;
    if (data.usage)
      row.usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      };
  } catch (error) {
    row.error =
      error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
        ? "timeout"
        : "transport";
  }
}

function binarySamples(fixtures: JudgeFixture[], rows: BenchRow[], id: string): BinarySample[] {
  const map = new Map(rows.map((row) => [row.caseId, row]));
  return fixtures
    .filter((f) => typeof f.labels[id] === "boolean")
    .map((fixture) => {
      const row = map.get(fixture.id);
      const answer = row?.answers[id];
      return {
        expected: fixture.labels[id] as boolean,
        probability: answer?.type === "noul" ? answer.noul : null,
        ...(id === "promote" && row?.incumbentDecision !== undefined
          ? { decision: row.incumbentDecision }
          : {}),
      };
    });
}

function summarizeQuality(
  fixtures: JudgeFixture[],
  firstRows: BenchRow[],
): Record<string, Record<string, unknown>> {
  const quality: Record<string, Record<string, unknown>> = {};
  for (const split of ["calibration", "test"] as const) {
    quality[split] = {};
    const selected = fixtures.filter((f) => f.split === split);
    const ids = [...new Set(selected.flatMap((f) => Object.keys(f.labels)))];
    for (const id of ids) {
      const gold = selected.find((f) => id in f.labels)?.labels[id];
      if (typeof gold === "boolean")
        quality[split][id] = binaryMetrics(binarySamples(selected, firstRows, id));
      else if (typeof gold === "string")
        quality[split][id] = categoricalMetrics(
          selected
            .filter((f) => typeof f.labels[id] === "string")
            .map((f) => {
              const answer = firstRows.find((row) => row.caseId === f.id)?.answers[id];
              return {
                expected: f.labels[id] as string,
                selected: answer?.type === "choice" ? answer.choice : null,
                probabilities: answer?.type === "choice" ? answer.probabilities : null,
              };
            }),
        );
      else {
        const scores = selected.flatMap((f) => {
          const answer = firstRows.find((row) => row.caseId === f.id)?.answers[id];
          return typeof f.labels[id] === "number" && answer?.type === "score"
            ? [Math.abs(answer.score - f.labels[id])]
            : [];
        });
        quality[split][id] = {
          selected: selected.filter((f) => id in f.labels).length,
          answered: scores.length,
          meanAbsoluteError: scores.length
            ? scores.reduce((s, n) => s + n, 0) / scores.length
            : null,
        };
      }
    }
  }
  return quality;
}

export interface BenchSummary {
  status: BenchOutput["status"];
  config: JudgeBenchConfig;
  fixtureSha256: string;
  firstRequestMs: number | null;
  requests: number;
  answered: number;
  failures: Record<string, number>;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  requestsPerSecond: number | null;
  quality: Record<string, Record<string, unknown>>;
  thresholdFit: {
    method: string;
    threshold: number | null;
    heldOut: ReturnType<typeof binaryMetrics> | null;
  };
  directThresholdFit: {
    threshold: number | null;
    heldOut: ReturnType<typeof binaryMetrics> | null;
  };
  authority: string;
  qualityUses: string;
}

export function summarizeBench(output: BenchOutput, fixtures: JudgeFixture[]): BenchSummary {
  const firstRows = output.rows.filter((row) => row.iteration === 0);
  const quality = output.status === "executed" ? summarizeQuality(fixtures, firstRows) : {};
  const calibration = fixtures.filter((f) => f.split === "calibration");
  const threshold = selectThreshold(
    binarySamples(calibration, firstRows, "filtered_promote"),
    0.02,
  );
  const directThreshold =
    output.config.protocol === "systemone"
      ? selectThreshold(binarySamples(calibration, firstRows, "promote"), 0.02)
      : null;
  const ordered = output.rows
    .filter((row) => row.startedOffsetMs !== undefined)
    .sort((a, b) => (a.startedOffsetMs ?? 0) - (b.startedOffsetMs ?? 0));
  const called = output.rows.filter((row) => row.error !== "unsupported");
  return {
    status: output.status,
    config: output.config,
    fixtureSha256: output.fixtureSha256,
    firstRequestMs: ordered[0]?.latencyMs ?? null,
    requests: called.length,
    answered: called.filter((row) => row.error === null).length,
    failures: Object.fromEntries(
      [...new Set(called.flatMap((row) => (row.error ? [row.error] : [])))].map((error) => [
        error,
        called.filter((row) => row.error === error).length,
      ]),
    ),
    p50LatencyMs: percentile(
      called.map((row) => row.latencyMs),
      0.5,
    ),
    p95LatencyMs: percentile(
      called.map((row) => row.latencyMs),
      0.95,
    ),
    requestsPerSecond:
      output.status === "executed" && output.elapsedMs > 0
        ? (called.length * 1000) / output.elapsedMs
        : null,
    quality,
    thresholdFit: {
      method: "calibration-only grid, max observed false-promotion rate 0.02; provisional labels",
      threshold,
      heldOut:
        threshold === null
          ? null
          : binaryMetrics(
              binarySamples(
                fixtures.filter((f) => f.split === "test"),
                firstRows,
                "filtered_promote",
              ),
              threshold,
            ),
    },
    directThresholdFit: {
      threshold: directThreshold,
      heldOut:
        directThreshold === null
          ? null
          : binaryMetrics(
              binarySamples(
                fixtures.filter((f) => f.split === "test"),
                firstRows,
                "promote",
              ),
              directThreshold,
            ),
    },
    authority: "none; mode=shadow, applied=false; no production database opened",
    qualityUses: "first iteration only; repeats are performance samples, not independent labels",
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: "string" },
      fixtures: { type: "string" },
      out: { type: "string" },
      live: { type: "boolean", default: false },
      concurrency: { type: "string", default: "1" },
      repeats: { type: "string", default: "1" },
      workload: { type: "string" },
    },
    strict: true,
  });
  if (!values.config || !values.fixtures || !values.out)
    throw new Error(
      "--config FILE --fixtures FILE --out DIR [--live] [--concurrency N] [--repeats N] [--workload promotion|efficacy|task-profile]",
    );
  const config = benchConfigSchema.parse(JSON.parse(readFileSync(values.config, "utf8")));
  const fixtures = readFileSync(values.fixtures, "utf8")
    .trim()
    .split("\n")
    .map((line) => fixtureSchema.parse(JSON.parse(line)))
    .filter((f) => !values.workload || f.workload === values.workload);
  if (fixtures.length === 0) throw new Error("no selected fixtures");
  const output = await runJudgeBench(config, fixtures, {
    live: values.live,
    fetch: (url, init) => globalThis.fetch(url, init),
    concurrency: Number(values.concurrency),
    repeats: Number(values.repeats),
  });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(
    join(values.out, "requests.jsonl"),
    output.rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(join(values.out, "run.json"), JSON.stringify(output, null, 2) + "\n");
  const summary = summarizeBench(output, fixtures);
  writeFileSync(join(values.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      status: summary.status,
      requests: summary.requests,
      answered: summary.answered,
      p50LatencyMs: summary.p50LatencyMs,
      p95LatencyMs: summary.p95LatencyMs,
      requestsPerSecond: summary.requestsPerSecond,
    }) + "\n",
  );
}
