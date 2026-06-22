import { load as parseYaml } from "js-yaml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { BENCH_TASKS, type BenchTask } from "./bench-prompts.js";

/**
 * bench-grade.ts
 *
 * Helper to grade bench-2 JSONL results using a judge LLM (default: mac-mini gemma E4B).
 * Dispatches one grading prompt per task in parallel.
 */

interface GradeOpts {
  inputPath: string;
  url: string;
  model: string;
  authToken?: string;
  caPath?: string;
  fetch?: typeof fetch;
}

export interface GradeResult {
  task: string;
  verdict: string;
  model: string;
  label: string;
}

export interface GradeInputEntry {
  task: string;
  answer?: unknown;
  model: string;
  label: string;
  error?: unknown;
}

export interface GradeResultsOpts {
  results: GradeInputEntry[];
  url: string;
  model: string;
  authToken?: string;
  caPath?: string;
  fetch?: typeof fetch;
  /** Abort signal for cancelling the grading. */
  signal?: AbortSignal;
}

// `tls` is a Bun-only RequestInit extension. Type it explicitly so we
// avoid a per-call cast at every fetch site that needs custom CA bytes.
type FetchInitWithTls = RequestInit & { tls?: { ca: string } };

interface JudgeChoice {
  message?: { content?: string };
}

interface JudgeResponse {
  choices?: JudgeChoice[];
}

const T2MemoryExtractionSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  kind: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function stripCodeFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseSchemaAnswer(
  stripped: string,
): { ok: true; value: z.infer<typeof T2MemoryExtractionSchema>[] } | { ok: false; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e: unknown) {
    return {
      ok: false,
      detail: `malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const result = z.array(T2MemoryExtractionSchema).safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      detail: `schema violation: ${result.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  return { ok: true, value: result.data };
}

export function gradeSchemaTask(
  task: BenchTask,
  answer: string | undefined,
): { verdict: "PASS" | "PARTIAL" | "FAIL"; detail: string } {
  if (!answer) {
    return { verdict: "FAIL", detail: "no answer" };
  }
  const parsed = parseSchemaAnswer(stripCodeFence(answer));
  if (!parsed.ok) {
    return { verdict: "FAIL", detail: parsed.detail };
  }

  const actual = parsed.value;
  const expected = task.expected_extractions ?? [];

  if (expected.length === 0) {
    return actual.length === 0
      ? { verdict: "PASS", detail: "empty as expected" }
      : {
          verdict: "FAIL",
          detail: `expected empty, got ${String(actual.length)} extractions`,
        };
  }

  let matched = 0;
  for (const exp of expected) {
    const hit = actual.some(
      (a) =>
        a.title.toLowerCase().includes(exp.title_substr.toLowerCase()) &&
        a.body.toLowerCase().includes(exp.body_substr.toLowerCase()) &&
        a.kind === exp.kind,
    );
    if (hit) {
      matched++;
    }
  }

  if (matched === expected.length) {
    return { verdict: "PASS", detail: `${String(matched)}/${String(expected.length)} matched` };
  }
  if (matched > 0) {
    return { verdict: "PARTIAL", detail: `${String(matched)}/${String(expected.length)} matched` };
  }
  return { verdict: "FAIL", detail: "0 expected extractions found" };
}

function answerString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeVerdict(content: string): string {
  const verdict = content.trim().toUpperCase();
  if (verdict.includes("PASS")) {
    return "PASS";
  }
  if (verdict.includes("PARTIAL")) {
    return "PARTIAL";
  }
  return "FAIL";
}

async function callJudge(
  entry: GradeInputEntry,
  task: BenchTask,
  groundTruth: string,
  opts: GradeResultsOpts,
  fetcher: typeof fetch,
): Promise<GradeResult> {
  const answerText = typeof entry.answer === "string" ? entry.answer : "(no answer)";
  const prompt = `Grade ONE bench-2 task. Output STRICTLY one of: PASS / FAIL / PARTIAL — nothing else, no period, no explanation.

GROUND TRUTH:
${groundTruth}

MODEL ANSWER:
${answerText}`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.authToken) {
    headers.authorization = `Bearer ${opts.authToken}`;
  }

  const body = JSON.stringify({
    model: opts.model,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const init: FetchInitWithTls = {
    method: "POST",
    headers,
    body,
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  };

  if (opts.caPath && existsSync(opts.caPath)) {
    init.tls = { ca: readFileSync(opts.caPath, "utf8") };
  }

  try {
    const res = await fetcher(`${opts.url.replace(/\/$/, "")}/chat/completions`, init);
    if (!res.ok) {
      throw new Error(`HTTP ${String(res.status)}`);
    }
    const json = (await res.json()) as JudgeResponse;
    const content = json.choices?.[0]?.message?.content ?? "FAIL";

    return {
      task: entry.task,
      verdict: sanitizeVerdict(content),
      model: entry.model,
      label: entry.label,
    };
  } catch (err: unknown) {
    return {
      task: entry.task,
      verdict: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      model: entry.model,
      label: entry.label,
    };
  }
}

export async function gradeResults(opts: GradeResultsOpts): Promise<GradeResult[]> {
  const groundTruthMap = new Map(BENCH_TASKS.map((t) => [t.id, t.groundTruth]));
  const fetcher = opts.fetch ?? fetch;

  const promises = opts.results.map(async (entry): Promise<GradeResult> => {
    const task = BENCH_TASKS.find((t) => t.id === entry.task);
    if (!task) {
      throw new Error(`unknown task ID: ${entry.task}`);
    }
    const groundTruth = groundTruthMap.get(task.id);
    if (!groundTruth) {
      throw new Error(`unknown task ID: ${entry.task}`);
    }

    if (task.schema === "T2MemoryExtraction[]") {
      const schemaVerdict = gradeSchemaTask(
        task,
        typeof entry.answer === "string" ? entry.answer : undefined,
      );
      return {
        task: entry.task,
        verdict: schemaVerdict.verdict,
        model: entry.model,
        label: entry.label,
      };
    }

    if (answerString(entry.answer) === "" || errorString(entry.error) !== "") {
      return { task: entry.task, verdict: "FAIL", model: entry.model, label: entry.label };
    }

    return await callJudge(entry, task, groundTruth, opts, fetcher);
  });

  return await Promise.all(promises);
}

async function runGrade(opts: GradeOpts): Promise<GradeResult[]> {
  if (!existsSync(opts.inputPath)) {
    throw new Error(`input file not found: ${opts.inputPath}`);
  }

  const lines = readFileSync(opts.inputPath, "utf8").trim().split("\n");
  const results = lines
    .filter((l) => l.trim())
    .map((l): GradeInputEntry => JSON.parse(l) as GradeInputEntry);

  return await gradeResults({
    results,
    url: opts.url,
    model: opts.model,
    authToken: opts.authToken,
    caPath: opts.caPath,
    fetch: opts.fetch,
  });
}

interface AgentConfigShape {
  name?: string;
  options?: { apiKey?: string };
}

interface AgentchatConfigShape {
  agents?: AgentConfigShape[];
}

function getApiKeyFromConfig(): string | undefined {
  const configPath = join(homedir(), ".config", "agentchat", "agentchat.yaml");
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const config = parseYaml(readFileSync(configPath, "utf8")) as AgentchatConfigShape | null;
    const executor = config?.agents?.find((a) => a.name === "executor");
    return executor?.options?.apiKey;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < argv.length) {
      return argv[i + 1];
    }
    return undefined;
  };

  const inputPath = flag("input") ?? argv[0];
  if (!inputPath || inputPath.startsWith("--")) {
    console.error(
      "usage: bun bench-grade.ts --input <jsonl-path> [--url <url>] [--model <model>] [--auth-token <token>] [--auth-cert <path>]",
    );
    process.exit(1);
  }

  const url = flag("url") ?? "https://192.168.68.76:7843/v1";
  const model = flag("model") ?? "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf";
  const authToken = flag("auth-token") ?? getApiKeyFromConfig();
  const caPath = flag("auth-cert") ?? "/tmp/llamactl-mac-mini-ca.pem";

  const results = await runGrade({ inputPath, url, model, authToken, caPath });
  for (const r of results) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
}

export { runGrade };
