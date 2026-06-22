import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BENCH_SYSTEM_PROMPT, BENCH_TASKS, type BenchTask } from "./bench-prompts.js";

export interface RunBenchOpts {
  label: string;
  url: string;
  model: string;
  maxTokensMultiplier?: number;
  authToken?: string;
  caPath?: string;
  fetch?: typeof fetch;
  /**
   * Strict OpenAI-compat providers (e.g. Groq) reject unknown body fields.
   * When true, omit `chat_template_kwargs` from the request body.
   */
  strictOpenAI?: boolean;
  /**
   * For OpenAI reasoning models (`gpt-oss-*`, `o1`, `o3`...) — controls how
   * much of the token budget goes to chain-of-thought vs the final answer.
   * Pass as `low` to leave room for the actual answer at small max_tokens.
   */
  reasoningEffort?: "low" | "medium" | "high";
  /** Arbitrary OpenAI-compat extra body fields. */
  extraBody?: Record<string, unknown>;
  /** Override one or more task fixtures (testing seam). */
  fixtureOverrides?: Partial<Record<BenchTask["id"], string>>;
  /** Abort signal for cancelling the benchmark. */
  signal?: AbortSignal;
}

export interface BenchResult {
  label: string;
  model: string;
  task: BenchTask["id"];
  description: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  answer?: string;
  groundTruth: string;
  latencyMs: number;
  error?: string;
}

interface ChatCompletionMessage {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage;
}

interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

interface FetchInitWithTls extends RequestInit {
  tls?: { ca: string };
}

function resolveFixture(scriptsDir: string, fixturePath: string): string {
  return resolve(scriptsDir, fixturePath);
}

function buildRequestBody(opts: RunBenchOpts, task: BenchTask, userContent: string): string {
  const bodyObj: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_tokens: Math.ceil(task.maxTokens * (opts.maxTokensMultiplier ?? 1)),
    messages: [
      { role: "system", content: BENCH_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };
  if (!opts.strictOpenAI) {
    bodyObj.chat_template_kwargs = { enable_thinking: false };
  }
  if (opts.reasoningEffort) {
    bodyObj.reasoning_effort = opts.reasoningEffort;
  }
  if (opts.extraBody) {
    Object.assign(bodyObj, opts.extraBody);
  }
  return JSON.stringify(bodyObj);
}

function buildInit(opts: RunBenchOpts, body: string): FetchInitWithTls {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.authToken) {
    headers.authorization = `Bearer ${opts.authToken}`;
  }
  const init: FetchInitWithTls = {
    method: "POST",
    headers,
    body,
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  };
  if (opts.caPath) {
    init.tls = { ca: readFileSync(opts.caPath, "utf8") };
  }
  return init;
}

function extractAnswer(json: ChatCompletionResponse): string {
  const msg = json.choices?.[0]?.message;
  if (msg?.content !== undefined && msg.content.length > 0) {
    return msg.content;
  }
  return msg?.reasoning_content ?? msg?.reasoning ?? "";
}

function parseResponse(text: string): ChatCompletionResponse {
  if (text.length === 0) {
    throw new Error("empty response body");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed as ChatCompletionResponse;
  } catch {
    throw new Error(`non-JSON body: ${text.slice(0, 80)}`);
  }
}

async function runOneTask(
  opts: RunBenchOpts,
  task: BenchTask,
  scriptsDir: string,
  fetcher: typeof fetch,
): Promise<BenchResult> {
  const start = Date.now();
  try {
    const overridePath = opts.fixtureOverrides?.[task.id];
    const fixturePath = overridePath
      ? resolve(overridePath)
      : resolveFixture(scriptsDir, task.fixturePath);
    if (!existsSync(fixturePath)) {
      throw new Error(`fixture not found: ${fixturePath}`);
    }
    const fixtureBody = readFileSync(fixturePath, "utf8");
    const userContent = `--- File: ${task.fixtureLabel} ---\n${fixtureBody}\n\n---\n\n${task.question}`;
    const body = buildRequestBody(opts, task, userContent);
    const init = buildInit(opts, body);

    const res = await fetcher(`${opts.url.replace(/\/$/, "")}/chat/completions`, init);
    if (!res.ok) {
      throw new Error(`HTTP ${String(res.status)}`);
    }
    const text = await res.text();
    const json = parseResponse(text);
    const answer = extractAnswer(json);
    return {
      label: opts.label,
      model: opts.model,
      task: task.id,
      description: task.description,
      prompt_tokens: json.usage?.prompt_tokens,
      completion_tokens: json.usage?.completion_tokens,
      answer,
      groundTruth: task.groundTruth,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      label: opts.label,
      model: opts.model,
      task: task.id,
      description: task.description,
      groundTruth: task.groundTruth,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runBench(opts: RunBenchOpts): Promise<BenchResult[]> {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const fetcher = opts.fetch ?? fetch;
  const results: BenchResult[] = [];
  for (const task of BENCH_TASKS) {
    results.push(await runOneTask(opts, task, scriptsDir, fetcher));
  }
  return results;
}

function parseReasoningEffort(value: string | undefined): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const label = flag("label");
  const url = flag("url");
  const model = flag("model") ?? "local";
  const authToken = flag("auth-token");
  const caPath = flag("auth-cert");
  const strictOpenAI = argv.includes("--strict-openai");
  const reasoningEffort = parseReasoningEffort(flag("reasoning-effort"));
  const extraBodyJson = flag("extra-body-json");
  const maxTokensMultiplierRaw = flag("max-tokens-multiplier");
  if (!label || !url) {
    console.error(
      "usage: bun bench.ts --label NAME --url URL [--model M] [--auth-token T] [--auth-cert PATH] [--strict-openai] [--reasoning-effort low|medium|high] [--extra-body-json JSON] [--max-tokens-multiplier N]",
    );
    process.exit(1);
  }
  const opts: RunBenchOpts = { label, url, model };
  if (authToken) {
    opts.authToken = authToken;
  }
  if (caPath) {
    opts.caPath = caPath;
  }
  if (strictOpenAI) {
    opts.strictOpenAI = true;
  }
  if (reasoningEffort) {
    opts.reasoningEffort = reasoningEffort;
  }
  if (extraBodyJson) {
    try {
      const parsedExtra: unknown = JSON.parse(extraBodyJson);
      opts.extraBody = parsedExtra as Record<string, unknown>;
    } catch (err) {
      console.error(
        `invalid --extra-body-json: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
  if (maxTokensMultiplierRaw !== undefined) {
    const parsed = Number(maxTokensMultiplierRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error("invalid --max-tokens-multiplier: must be a number greater than 0");
      process.exit(1);
    }
    opts.maxTokensMultiplier = parsed;
  }
  const out = await runBench(opts);
  for (const r of out) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
}
