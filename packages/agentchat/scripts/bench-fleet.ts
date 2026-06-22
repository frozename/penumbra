import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ApiKeyOpts } from "../src/adapters/secret.js";
import type { AgentChatConfig } from "../src/config/types.js";

import { resolveAdapterApiKey } from "../src/adapters/secret.js";
import { loadConfig } from "../src/config/load.js";
import { type GradeResult, gradeResults } from "./bench-grade.js";
import { BENCH_TASKS } from "./bench-prompts.js";
import { type BenchResult, runBench } from "./bench.js";

/**
 * bench-fleet.ts
 *
 * Dispatches bench-2 against all configured HTTP-direct cloud agents,
 * then pipes each agent's results through bench-grade.ts to produce a summary calibration table.
 *
 * Resilience features:
 * - Per-agent timeout (default 180s, --per-agent-timeout-ms)
 * - Skip-on-error: Continues to next agent if one fails.
 * - Skip-by-tag: By default, skips agents with tags 'avoid-on-free-tier' or 'swap-required'.
 *   Override with --include-tags or --exclude-tags.
 */

export interface FleetBenchDeps {
  existsSync: typeof existsSync;
  loadConfig: typeof loadConfig;
  resolveAdapterApiKey: typeof resolveAdapterApiKey;
  runBench: typeof runBench;
  gradeResults: typeof gradeResults;
}

interface FleetBenchOpts {
  include?: RegExp;
  exclude?: RegExp;
  includeTags?: string[];
  excludeTags?: string[];
  perAgentTimeoutMs?: number;
  skipGrade?: boolean;
  judgeUrl?: string;
  judgeModel?: string;
  judgeToken?: string;
  judgeCaPath?: string;
  fetch?: typeof fetch;
  /** Optional: provide config directly (tests / embedding). */
  config?: AgentChatConfig;
  /** Optional: override default config path. */
  configPath?: string;
  /** Optional: dependency injection seam (tests). */
  deps?: Partial<FleetBenchDeps>;
}

interface FleetAgentResult {
  bench?: BenchResult[];
  grades?: GradeResult[];
  status?: string;
  error?: string;
}

type FleetResults = Record<string, FleetAgentResult>;

type FleetAgent = AgentChatConfig["agents"][number];

const DEFAULT_SKIP_TAGS = ["avoid-on-free-tier", "swap-required"];
const DEFAULT_JUDGE_URL = "https://192.168.68.76:7843/v1";
const DEFAULT_JUDGE_MODEL = "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf";
const DEFAULT_JUDGE_CA = "/tmp/llamactl-mac-mini-ca.pem";
const DEFAULT_PER_AGENT_TIMEOUT_MS = 180_000;
const STRICT_OPENAI_HOST_RE = /groq\.com|generativelanguage\.googleapis\.com|openai\.com/;

function pickApiKeyOpts(options: Record<string, unknown>): ApiKeyOpts {
  return {
    apiKey: typeof options.apiKey === "string" ? options.apiKey : undefined,
    apiKeyEnv: typeof options.apiKeyEnv === "string" ? options.apiKeyEnv : undefined,
    apiKeyKeychain: typeof options.apiKeyKeychain === "string" ? options.apiKeyKeychain : undefined,
    apiKeyFile: typeof options.apiKeyFile === "string" ? options.apiKeyFile : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDefaultJudgeToken(
  config: AgentChatConfig,
  deps: FleetBenchDeps,
): string | undefined {
  const executor = config.agents.find((a) => a.name === "executor");
  if (!executor) {
    return undefined;
  }
  try {
    return deps.resolveAdapterApiKey(pickApiKeyOpts(executor.options ?? {}), {
      hostPlatform: process.platform,
    });
  } catch {
    return undefined;
  }
}

function loadFleetConfig(opts: FleetBenchOpts, deps: FleetBenchDeps): AgentChatConfig {
  if (opts.config) {
    return opts.config;
  }
  const configPath = opts.configPath ?? join(homedir(), ".config", "agentchat", "agentchat.yaml");
  if (!deps.existsSync(configPath)) {
    throw new Error(`agentchat.yaml not found at ${configPath}`);
  }
  return deps.loadConfig(configPath);
}

function computeSkipReason(agent: FleetAgent, opts: FleetBenchOpts): string | undefined {
  if (opts.include?.test(agent.name) === false) {
    return "filtered by name";
  }
  if (opts.exclude?.test(agent.name) === true) {
    return "filtered by name";
  }
  const agentTags = agent.tags ?? [];
  if (opts.includeTags) {
    if (!agentTags.some((t) => opts.includeTags?.includes(t) === true)) {
      return "filtered by tags (not included)";
    }
    return undefined;
  }
  const excludeTags = opts.excludeTags ?? DEFAULT_SKIP_TAGS;
  if (agentTags.some((t) => excludeTags.includes(t))) {
    return "tag mismatch (excluded)";
  }
  return undefined;
}

interface AgentRunParams {
  baseUrl: string;
  model: string;
  caPath: string | undefined;
  extraBody: Record<string, unknown> | undefined;
  apiKey: string;
}

function extractAgentParams(
  agent: FleetAgent,
  deps: FleetBenchDeps,
): { params?: AgentRunParams; error?: string } {
  const options = agent.options ?? {};
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : undefined;
  const model = typeof options.model === "string" ? options.model : undefined;
  const caPath = typeof options.caPath === "string" ? options.caPath : undefined;
  const extraBody = isRecord(options.extraBody) ? options.extraBody : undefined;
  if (!baseUrl || !model) {
    return { error: "missing baseUrl or model" };
  }
  try {
    const apiKey = deps.resolveAdapterApiKey(pickApiKeyOpts(options), {
      hostPlatform: process.platform,
    });
    return { params: { baseUrl, model, caPath, extraBody, apiKey } };
  } catch (err) {
    return {
      error: `apiKey resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function gradeAgent(
  agentName: string,
  benchResults: BenchResult[],
  opts: FleetBenchOpts,
  deps: FleetBenchDeps,
  config: AgentChatConfig,
  timeoutMs: number,
): Promise<GradeResult[]> {
  console.error(`Grading ${agentName}...`);
  const judgeToken = opts.judgeToken ?? resolveDefaultJudgeToken(config, deps);
  return await withTimeout(
    async (signal) =>
      await deps.gradeResults({
        results: benchResults,
        url: opts.judgeUrl ?? DEFAULT_JUDGE_URL,
        model: opts.judgeModel ?? DEFAULT_JUDGE_MODEL,
        authToken: judgeToken,
        caPath: opts.judgeCaPath ?? DEFAULT_JUDGE_CA,
        fetch: opts.fetch,
        signal,
      }),
    timeoutMs,
  );
}

function isExpectedError(err: unknown): err is Error {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.name === "AbortError") {
    return true;
  }
  return (
    err.message.includes("HTTP") ||
    err.message.includes("fetch") ||
    err.message.includes("network") ||
    err.message.includes("auth") ||
    err.message.includes("key")
  );
}

async function benchAgent(
  agent: FleetAgent,
  params: AgentRunParams,
  opts: FleetBenchOpts,
  deps: FleetBenchDeps,
  config: AgentChatConfig,
): Promise<FleetAgentResult> {
  const isStrict = STRICT_OPENAI_HOST_RE.test(params.baseUrl);
  const timeoutMs = opts.perAgentTimeoutMs ?? DEFAULT_PER_AGENT_TIMEOUT_MS;
  console.error(`Benchmarking ${agent.name}...`);
  try {
    const benchResults = await withTimeout(
      async (signal) =>
        await deps.runBench({
          label: agent.name,
          url: params.baseUrl,
          model: params.model,
          authToken: params.apiKey,
          caPath: params.caPath,
          extraBody: params.extraBody,
          strictOpenAI: isStrict,
          fetch: opts.fetch,
          signal,
        }),
      timeoutMs,
    );
    const result: FleetAgentResult = { bench: benchResults };
    if (!opts.skipGrade) {
      result.grades = await gradeAgent(agent.name, benchResults, opts, deps, config, timeoutMs);
    }
    return result;
  } catch (err) {
    if (err instanceof TimeoutError || (err instanceof Error && err.name === "TimeoutError")) {
      console.error(`Timeout benchmarking ${agent.name}`);
      return { status: "TIMEOUT" };
    }
    if (isExpectedError(err)) {
      console.error(`Error benchmarking ${agent.name}: ${err.message}`);
      return { status: "ERROR", error: err.message };
    }
    throw err; // Fail loud for helper bugs (TypeError, ReferenceError, etc.)
  }
}

async function runFleetBench(opts: FleetBenchOpts = {}): Promise<void> {
  const deps: FleetBenchDeps = {
    existsSync,
    loadConfig,
    resolveAdapterApiKey,
    runBench,
    gradeResults,
    ...opts.deps,
  };
  const config = loadFleetConfig(opts, deps);
  const agents = config.agents.filter((a) => a.adapter === "openai-compat-http");
  if (agents.length === 0) {
    process.stdout.write("No matching openai-compat-http agents found.\n");
    return;
  }
  const fleetResults: FleetResults = {};
  for (const agent of agents) {
    const skipReason = computeSkipReason(agent, opts);
    if (skipReason) {
      fleetResults[agent.name] = { status: "SKIPPED" };
      continue;
    }
    const { params, error } = extractAgentParams(agent, deps);
    if (!params) {
      console.warn(`Skipping agent ${agent.name}: ${error ?? "unknown error"}`);
      fleetResults[agent.name] = { status: "ERROR", error };
      continue;
    }
    fleetResults[agent.name] = await benchAgent(agent, params, opts, deps, config);
  }
  printSummaryTable(fleetResults, opts.skipGrade);
}

class TimeoutError extends Error {
  constructor() {
    super("Timeout");
    this.name = "TimeoutError";
  }
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new TimeoutError());
  }, ms);

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        const reason: unknown = controller.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    controller.abort(); // Cancel underlying work if still running
  }
}

function verdictGlyph(verdict: string | undefined): string {
  if (!verdict) {
    return "?";
  }
  if (verdict === "PASS") {
    return "✅";
  }
  if (verdict === "PARTIAL") {
    return "⚠️";
  }
  if (verdict.startsWith("ERROR")) {
    return "❌";
  }
  return "🛑";
}

function printSummaryTable(fleetResults: FleetResults, skipGrade?: boolean): void {
  const taskIds = BENCH_TASKS.map((t) => t.id);
  const header = `| Agent | ${taskIds.join(" | ")} | Net | Latency p50 |`;
  const separator = `| :--- | ${taskIds.map(() => ":---:").join(" | ")} | :---: | :---: |`;

  process.stdout.write(header + "\n");
  process.stdout.write(separator + "\n");

  for (const [name, data] of Object.entries(fleetResults)) {
    if (data.status) {
      const statusMsg = data.status === "ERROR" ? `ERROR: ${data.error ?? "unknown"}` : data.status;
      const fillers = taskIds.map(() => statusMsg).join(" | ");
      process.stdout.write(`| ${name} | ${fillers} | ${statusMsg} | ${statusMsg} |\n`);
      continue;
    }

    const bench = data.bench ?? [];
    const latencies = bench.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p50 = latencies.length > 0 ? (latencies[Math.floor(latencies.length / 2)] ?? 0) : 0;

    const taskVerdicts = taskIds.map((taskId) => {
      if (skipGrade) {
        return "-";
      }
      return verdictGlyph(data.grades?.find((g) => g.task === taskId)?.verdict);
    });

    let net: string;
    if (skipGrade) {
      net = "N/A";
    } else {
      const passCount = data.grades?.filter((g) => g.verdict === "PASS").length ?? 0;
      net = `${String(passCount)}/${String(taskIds.length)}`;
    }

    process.stdout.write(`| ${name} | ${taskVerdicts.join(" | ")} | ${net} | ${String(p50)}ms |\n`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const includeStr = flag("include");
  const excludeStr = flag("exclude");
  const includeTagsStr = flag("include-tags");
  const excludeTagsStr = flag("exclude-tags");
  const perAgentTimeoutStr = flag("per-agent-timeout-ms");
  const skipGrade = argv.includes("--skip-grade");

  let perAgentTimeoutMs: number | undefined;
  if (perAgentTimeoutStr) {
    perAgentTimeoutMs = parseInt(perAgentTimeoutStr, 10);
    if (isNaN(perAgentTimeoutMs) || perAgentTimeoutMs <= 0) {
      console.error("Error: --per-agent-timeout-ms must be a positive integer");
      process.exit(1);
    }
  }

  const opts: FleetBenchOpts = {
    include: includeStr ? new RegExp(includeStr) : undefined,
    exclude: excludeStr ? new RegExp(excludeStr) : undefined,
    includeTags: includeTagsStr ? includeTagsStr.split(",") : undefined,
    excludeTags: excludeTagsStr ? excludeTagsStr.split(",") : undefined,
    perAgentTimeoutMs,
    skipGrade,
    judgeUrl: flag("judge-url"),
    judgeModel: flag("judge-model"),
    judgeToken: flag("judge-token"),
    judgeCaPath: flag("judge-ca"),
  };

  try {
    await runFleetBench(opts);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export { type FleetBenchOpts, runFleetBench };
