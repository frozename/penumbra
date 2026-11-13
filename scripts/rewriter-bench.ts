import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  REWRITE_RESPONSE_SCHEMA,
  type RewriteResponse,
} from "../packages/daemon/src/dreaming/dream-rewriter-prompt-content.js";
import { buildDreamQueryRewritePrompt } from "../packages/daemon/src/dreaming/dream-rewriter-prompt.js";
import { isWebSearchable } from "../packages/daemon/src/dreaming/query-rewriting.js";
import { sanitizeTitleForQuery } from "../packages/daemon/src/dreaming/query-sanitize.js";
import { invokeRewriter } from "../packages/daemon/src/dreaming/rewrite-invoke.js";
import { llmInvoke } from "../packages/daemon/src/services/llm-invoke.js";

const ModelSchema = z
  .object({
    id: z.string().regex(/^[a-z\d][a-z\d._-]{0,63}$/),
    baseUrl: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname.replace(/\/$/, "") === "/v1"
        );
      } catch {
        return false;
      }
    }, "benchmark requires a credential-free loopback /v1 origin"),
    model: z.string().min(1).max(256),
    maxTokens: z.number().int().min(1).max(2048).default(512),
    timeoutMs: z.number().int().min(1).max(30000).default(30000),
  })
  .strict();
const ConfigSchema = z
  .object({
    models: z.array(ModelSchema).min(1).max(4),
    repetitions: z.number().int().min(1).max(3).default(1),
    concurrency: z.number().int().min(1).max(2).default(1),
  })
  .strict();
const CaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body_first_200: z.string().refine((value) => Array.from(value).length <= 200),
  expected_verdict: z.enum(["query", "skip", "uncertain"]),
  inputSha256: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .optional(),
  stratum: z.string().optional(),
});
export type ModelConfig = z.infer<typeof ModelSchema>;
export type BenchConfig = z.infer<typeof ConfigSchema>;
export type EvalCase = z.infer<typeof CaseSchema>;
export interface CellResult {
  model_id: string;
  model_name: string;
  case_id: string;
  expected_verdict: EvalCase["expected_verdict"];
  verdict: RewriteResponse["kind"] | null;
  query_or_reason: string;
  raw: string;
  latency_ms: number;
  error: string | null;
  correct: boolean | null;
  contract_issues: string[];
  production_gate_pass: boolean;
  gate_eligible_text: string | null;
}
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

export function parseBenchArgs(args: string[]): {
  configPath: string;
  fixturesPath: string;
  outDir: string;
} {
  if (!args.includes("--live")) throw new Error("Explicit --live required");
  const found = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--live") continue;
    if (!key || !["--config", "--fixtures", "--out"].includes(key) || found.has(key))
      throw new Error("Unknown or repeated benchmark argument");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("Missing benchmark argument value");
    found.set(key, value);
  }
  const configPath = found.get("--config"),
    fixturesPath = found.get("--fixtures"),
    outDir = found.get("--out");
  if (!configPath || !fixturesPath || !outDir)
    throw new Error("--config, --fixtures and fresh --out required");
  return { configPath, fixturesPath, outDir };
}

export function parseBenchConfig(raw: unknown): BenchConfig {
  const config = ConfigSchema.parse(raw);
  if (new Set(config.models.map((model) => model.id)).size !== config.models.length)
    throw new Error("Repeated model ID");
  return config;
}

export function parseBenchCases(text: string): EvalCase[] {
  const cases = text
    .trim()
    .split(/\r?\n/)
    .map((line) => CaseSchema.parse(JSON.parse(line) as unknown));
  const ids = new Set<string>(),
    hashes = new Set<string>();
  for (const row of cases) {
    const digest = sha(JSON.stringify({ title: row.title, body_first_200: row.body_first_200 }));
    if (ids.has(row.id) || hashes.has(digest))
      throw new Error("Repeated fixture identity or input");
    if (row.inputSha256 && row.inputSha256 !== digest)
      throw new Error("Fixture input hash mismatch");
    ids.add(row.id);
    hashes.add(digest);
  }
  return cases;
}

export function assessRewrite(
  value: RewriteResponse,
  raw: string,
): { issues: string[]; productionGatePass: boolean; sanitizedQuery: string | null } {
  const issues: string[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const allowed = value.kind === "query" ? ["kind", "query"] : ["kind", "reason"];
    if (typeof parsed !== "object" || !parsed || Array.isArray(parsed))
      issues.push("not_strict_object");
    else if (Object.keys(parsed).some((key) => !allowed.includes(key))) issues.push("extra_fields");
  } catch {
    issues.push("not_strict_json");
  }
  if (value.kind === "skip") {
    if (/[\r\n]/.test(value.reason)) issues.push("multiline_reason");
    return { issues, productionGatePass: false, sanitizedQuery: null };
  }
  const words = value.query.trim().split(/\s+/).length;
  if (words < 4 || words > 12) issues.push("word_count");
  if (/["'`#*]|[\r\n]/.test(value.query)) issues.push("quotes_or_markdown");
  const passes = isWebSearchable(value.query).ok;
  return {
    issues,
    productionGatePass: passes,
    sanitizedQuery: passes ? sanitizeTitleForQuery(value.query) : null,
  };
}

function titleFallback(title: string): string | null {
  return isWebSearchable(title).ok ? sanitizeTitleForQuery(title) : null;
}

export async function runCase(
  model: ModelConfig,
  input: EvalCase,
  fetchFn?: typeof fetch,
): Promise<CellResult> {
  const started = performance.now();
  const result = await invokeRewriter(llmInvoke, {
    baseUrl: model.baseUrl,
    model: model.model,
    auth: { source: "none" },
    options: { maxTokens: model.maxTokens, requestTimeoutMs: model.timeoutMs },
    messages: buildDreamQueryRewritePrompt({
      title: input.title,
      bodyFirst200: input.body_first_200,
    }),
    schema: REWRITE_RESPONSE_SCHEMA,
    timeoutMs: model.timeoutMs,
    temperature: 0,
    ...(fetchFn ? { fetchFn } : {}),
  });
  const base = {
    model_id: model.id,
    model_name: model.model,
    case_id: input.id,
    expected_verdict: input.expected_verdict,
    latency_ms: performance.now() - started,
  };
  if (!result.ok)
    return {
      ...base,
      verdict: null,
      query_or_reason: "",
      raw: "",
      error: result.reason,
      correct: input.expected_verdict === "uncertain" ? null : false,
      contract_issues: [],
      production_gate_pass: false,
      gate_eligible_text: titleFallback(input.title),
    };
  const audit = assessRewrite(result.value, result.raw);
  return {
    ...base,
    verdict: result.value.kind,
    query_or_reason: result.value.kind === "query" ? result.value.query : result.value.reason,
    raw: result.raw,
    error: null,
    correct:
      input.expected_verdict === "uncertain" ? null : result.value.kind === input.expected_verdict,
    contract_issues: audit.issues,
    production_gate_pass: audit.productionGatePass,
    gate_eligible_text:
      result.value.kind === "skip" ? null : (audit.sanitizedQuery ?? titleFallback(input.title)),
  };
}

const MetadataSchema = z.object({
  model: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  choices: z.array(z.object({ finish_reason: z.string().nullable().optional() })).optional(),
});
export async function readResponseMetadata(
  response: Pick<Response, "body">,
): Promise<z.infer<typeof MetadataSchema> | null> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 131072) return null;
      chunks.push(chunk.value);
    }
    const parsed = MetadataSchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function runBenchmark(
  config: BenchConfig,
  cases: EvalCase[],
  outDir: string,
  fixtureSha256: string,
): Promise<void> {
  mkdirSync(outDir, { mode: 0o700 });
  const path = join(outDir, "run.json"),
    startedAt = new Date().toISOString();
  const rows: (CellResult & { repetition: number })[] = [],
    calls: Record<string, unknown>[] = [];
  let complete = false;
  const save = (): void => {
    writeFileSync(
      path,
      JSON.stringify(
        {
          startedAt,
          updatedAt: new Date().toISOString(),
          complete,
          config,
          fixtureSha256,
          method:
            "Existing production rewriter prompt/schema/invoke path; no cache writes, research queue or downstream web search. Strict output and deterministic gate audited separately. Gate-eligible fallback text is an observation before research budgets/cooldowns, not a dispatched query.",
          rows,
          calls,
          applied: false,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  };
  writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 });
  try {
    for (const model of config.models) {
      const queue = Array.from({ length: config.repetitions }, (_, index) =>
        cases.map((input) => ({ input, repetition: index + 1 })),
      ).flat();
      let next = 0;
      await Promise.all(
        Array.from({ length: config.concurrency }, async () => {
          while (next < queue.length) {
            const work = queue[next++];
            if (!work) break;
            const transport: typeof fetch = Object.assign(
              async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (
                  typeof url !== "string" ||
                  url !== model.baseUrl.replace(/\/$/, "") + "/chat/completions"
                )
                  throw new Error("Unexpected benchmark network request refused");
                const requestBody = init?.body;
                if (typeof requestBody !== "string")
                  throw new Error("Unexpected benchmark request body");
                const at = performance.now();
                try {
                  const response = await fetch(url, init),
                    meta = await readResponseMetadata(response.clone());
                  calls.push({
                    modelId: model.id,
                    caseId: work.input.id,
                    repetition: work.repetition,
                    at: new Date().toISOString(),
                    status: response.status,
                    latencyMs: performance.now() - at,
                    requestSha256: sha(requestBody),
                    returnedModel: meta?.model,
                    usage: meta?.usage,
                    finishReason: meta?.choices?.[0]?.finish_reason,
                  });
                  return response;
                } catch (error) {
                  calls.push({
                    modelId: model.id,
                    caseId: work.input.id,
                    repetition: work.repetition,
                    error: String(error),
                    latencyMs: performance.now() - at,
                  });
                  throw error;
                }
              },
              { preconnect: fetch.preconnect },
            );
            const row = {
              ...(await runCase(model, work.input, transport)),
              repetition: work.repetition,
            };
            rows.push(row);
            save();
            process.stdout.write(
              JSON.stringify({
                model: model.id,
                caseId: row.case_id,
                repetition: row.repetition,
                latencyMs: row.latency_ms,
                error: row.error,
              }) + "\n",
            );
          }
        }),
      );
    }
    complete = true;
  } finally {
    save();
  }
  writeFileSync(join(outDir, "report.md"), renderSummary(rows, config.models), {
    flag: "wx",
    mode: 0o600,
  });
}

function renderSummary(rows: CellResult[], models: ModelConfig[]): string {
  const lines = [
    "# Rewriter benchmark",
    "",
    "Decision agreement is not semantic query quality. Uncertain labels and abstentions remain explicit.",
    "",
    "| Model | Correct labeled decisions | Errors | Strict contract issues |",
    "| --- | --- | --- | --- |",
    ...models.map((model) => {
      const scoped = rows.filter((row) => row.model_id === model.id),
        labeled = scoped.filter((row) => row.expected_verdict !== "uncertain");
      return `| ${model.id} | ${String(labeled.filter((row) => row.correct).length)}/${String(labeled.length)} | ${String(scoped.filter((row) => row.error).length)} | ${String(scoped.filter((row) => row.contract_issues.length).length)} |`;
    }),
  ];
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseBenchArgs(process.argv.slice(2));
  const config = parseBenchConfig(JSON.parse(readFileSync(args.configPath, "utf8")) as unknown),
    text = readFileSync(args.fixturesPath, "utf8");
  await runBenchmark(config, parseBenchCases(text), args.outDir, sha(text));
}
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
