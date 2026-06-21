import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Embedder } from "../packages/core/src/embedder/interface.js";

import { readEmbedderEnv } from "../packages/cli/src/commands/sirius-env.js";
import { assertEmbedderDim } from "../packages/core/src/db/migrations.js";
import { applyRuntimePragmas, loadSqliteVec } from "../packages/core/src/db/sqlite-vec.js";
import { BundledEmbedder } from "../packages/core/src/embedder/bundled.js";
import { resolveEmbedder } from "../packages/core/src/embedder/resolve.js";
import { type T2MemoryExtraction, T2Promotion } from "../packages/core/src/writers/t2.js";
import { createJudgePool, type JudgeEntry } from "../packages/daemon/src/workers/t2-judge-pool.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // The SQLite library may already be loaded in this process.
}

const DEFAULT_RUNTIMES = ["~/.bun-canary/bin/bun", "~/.bun/bin/bun"] as const;
const DEFAULT_RUNS_PER_RUNTIME = 3;
const LIVE_DB = "~/.penumbra/db.sqlite";
const T2_PROMPT_FILTER_RULE =
  "If a memory could be retrieved later by `git log`, `grep`, `find`, or just reading the code, DO NOT extract it. Memory is for things that take judgment to discover, not things that are mechanically discoverable.";
const T2_PROMOTION_PROMPT = `
You are extracting durable knowledge from a session transcript for long-term memory used by future sessions, possibly weeks or months from now. Your bar is high: extract ONLY things that future-you would benefit from knowing, not things any tool can rediscover.

EXTRACT (✅):
- Architectural decisions WITH rationale ("we chose Postgres over SQLite for the audit log because partitioning matters at 50 writes/sec")
- User preferences that persist across sessions ("user prefers vitest over jest to avoid config sprawl", "always run typecheck before tests")
- Project rules / conventions that are not trivially derivable from the code ("orchestrate dispatches must use trust=all", "agent branches are named agent/<handoff_id>")
- Long-lived domain facts that take time to discover ("the t2_vec table doesn't auto-reset when t2_memories is emptied — orphans remain")
- Traps, pitfalls, gotchas with their workaround ("granite emits <think> tags before JSON; strip them or parse fails")

DO NOT EXTRACT (❌):
- Single test runs ("ran bun test, 626 passed", "8 tests passed in 9ms")
- Single git commits ("committed as 54d00a1", "added retry logic in commit X") — git log already has this
- File paths / directory listings ("the worker is at packages/agentchat/...", "directories include adapters, cli, config") — find/grep already has this
- Transient session activity ("user opened the README", "tests are running", "build is green")
- Surface facts derivable from the code ("the project uses TypeScript", "tests live under test/")
- Anything that reads like a status update with no carry-over context

${T2_PROMPT_FILTER_RULE}

Discriminator rules (required for gateable promotion):
- Episodic narration (example: "a failing test was written, then implementation followed") must be tagged \`obs_type: "is_episodic"\` and \`promote: false\`.
- Long-lived standing instructions (example: "You are X, a long-lived agent...") must be tagged \`obs_type: "standing_brief"\` and \`promote: false\`.
- Density floor: when \`body\` is under 80 characters and \`depth < 2\`, set \`promote: false\`.
- Depth escape hatch: deep items (\`depth >= 2\`) may still be promotable even when short.
- Durable semantic facts with explicit rationale should include a non-empty \`why\` and set \`promote: true\`.

If nothing in the transcript clears the bar, the CORRECT answer is the literal string \`{"memories":[]}\` — an empty array. NOT the word "none", NOT "null", NOT prose explaining why nothing matched. Just \`{"memories":[]}\`. This is the right answer for chitchat, pure activity logs, and anything below the bar.

Output ONLY a valid JSON object: {"memories": [...]}. Each memory object: { title (short headline), body (the durable knowledge itself), kind ("fact" | "preference" | "decision" | "knowledge"), metadata (optional object), obs_type (optional string), why (optional string), source_quote (optional string), learned_at (optional ISO-8601 string), durability (optional string), depth (optional integer), is_episodic (optional boolean), promote (optional boolean) }. No prose. No code fence. No wrapper tags. No "none"/"null" string fallbacks.

Transcript:
{{TRANSCRIPT}}
`.trim();

export interface ParentArgs {
  mode: "parent";
  runtimes: string[];
  runsPerRuntime: number;
  stubEmbed: boolean;
}

export interface ChildArgs {
  mode: "child";
  stubEmbed: boolean;
}

export type CliArgs = ParentArgs | ChildArgs;

export interface RunSummary {
  runtime_binary: string;
  bun_version: string;
  exit_code: number | null;
  signal: string | null;
  outcome: string;
  duration_ms: number;
}

interface ChildResult {
  outcome: "completed" | "judge_failed" | "error";
  promoted_count: number;
}

interface MutableCliState {
  tick: boolean;
  runtimes: string[];
  runsPerRuntime: number;
  stubEmbed: boolean;
}

function applyRuntimesFlag(value: string | undefined, state: MutableCliState): void {
  if (!value) {
    throw new Error("--runtimes requires a comma-separated value");
  }
  const list = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (list.length === 0) {
    throw new Error("--runtimes requires at least one runtime");
  }
  state.runtimes = list;
}

function applyRunsFlag(value: string | undefined, state: MutableCliState): void {
  if (!value) {
    throw new Error("--runs requires a number");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--runs must be a positive integer");
  }
  state.runsPerRuntime = parsed;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const state: MutableCliState = {
    tick: false,
    runtimes: [...DEFAULT_RUNTIMES],
    runsPerRuntime: DEFAULT_RUNS_PER_RUNTIME,
    stubEmbed: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tick") {
      state.tick = true;
      continue;
    }
    if (arg === "--stub-embed") {
      state.stubEmbed = true;
      continue;
    }
    if (arg === "--runtimes") {
      applyRuntimesFlag(argv[++i], state);
      continue;
    }
    if (arg === "--runs") {
      applyRunsFlag(argv[++i], state);
      continue;
    }
    throw new Error(`unknown argument: ${String(arg)}`);
  }

  if (state.tick) {
    return { mode: "child", stubEmbed: state.stubEmbed };
  }
  return {
    mode: "parent",
    runtimes: state.runtimes.map(expandPath),
    runsPerRuntime: state.runsPerRuntime,
    stubEmbed: state.stubEmbed,
  };
}

export function buildSummaryLine(runs: RunSummary[]): string {
  return JSON.stringify({ runs });
}

async function runParent(args: ParentArgs): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url);
  const runs: RunSummary[] = [];
  for (const runtime of args.runtimes) {
    const bunVersion = readBunVersion(runtime);
    for (let i = 0; i < args.runsPerRuntime; i++) {
      runs.push(await runChild(runtime, bunVersion, scriptPath, args.stubEmbed));
    }
  }
  process.stdout.write(buildSummaryLine(runs) + "\n");
}

function resolveOutcome(
  parsed: ChildResult | null,
  signal: string | null,
  exitCode: number | null,
  stderr: string,
): string {
  if (parsed?.outcome) {
    return parsed.outcome;
  }
  if (signal) {
    return "crashed";
  }
  if (exitCode === 0) {
    return "completed";
  }
  if (stderr.includes("Segmentation fault")) {
    return "crashed";
  }
  return "error";
}

async function runChild(
  runtimeBinary: string,
  bunVersion: string,
  scriptPath: string,
  stubEmbed: boolean,
): Promise<RunSummary> {
  const started = Date.now();
  const childArgs = [runtimeBinary, scriptPath, "--tick"];
  if (stubEmbed) {
    childArgs.push("--stub-embed");
  }
  const proc = Bun.spawn(childArgs, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const signal = (proc as unknown as { signalCode?: string | null }).signalCode ?? null;
  const lastLine = lastStdoutLine(stdout);
  const parsed = parseChildLine(lastLine);
  const outcome = resolveOutcome(parsed, signal, exitCode, stderr);
  return {
    runtime_binary: runtimeBinary,
    bun_version: bunVersion,
    exit_code: exitCode,
    signal,
    outcome,
    duration_ms: Date.now() - started,
  };
}

function readBunVersion(runtimeBinary: string): string {
  try {
    const proc = Bun.spawnSync([runtimeBinary, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString().trim();
    if (out) {
      return out;
    }
    return `unknown(exit=${String(proc.exitCode)})`;
  } catch (err) {
    return `unavailable:${err instanceof Error ? err.message : String(err)}`;
  }
}

async function runChildTick(stubEmbed: boolean): Promise<ChildResult> {
  let db: Database | null = null;
  let tempDir: string | null = null;
  try {
    const copied = copyLiveDb();
    tempDir = copied.tempDir;
    db = new Database(copied.dbPath);
    loadSqliteVec(db);
    applyRuntimePragmas(db);

    const embedder = stubEmbed ? createStubEmbedder() : await createDaemonLikeEmbedder();
    assertEmbedderDim(db, embedder.dim, embedder.name);
    const judge = createJudgePool({
      judges: [REPRO_JUDGE],
      log: quietLog,
      promptBuilder: (transcript) => T2_PROMOTION_PROMPT.replace("{{TRANSCRIPT}}", transcript),
      parseResponse: parseJudgeResponse,
    });
    const t2 = new T2Promotion({
      db,
      embedder,
      clock: (): Date => new Date(),
      uuid: createUuidSequence(),
      llm: (transcript: string): Promise<string> => judge.invoke(transcript),
    });
    const [rollupId] = t2.detectEligibleRollups(0, new Date());
    const selectedRollupId = rollupId ?? latestRollupId(db);
    if (!selectedRollupId) {
      return { outcome: "completed", promoted_count: 0 };
    }
    try {
      const promoted = await t2.promoteRollup(selectedRollupId);
      return { outcome: "completed", promoted_count: promoted };
    } catch (err) {
      debugError(err);
      return { outcome: "judge_failed", promoted_count: 0 };
    }
  } catch (err) {
    debugError(err);
    return { outcome: "error", promoted_count: 0 };
  } finally {
    db?.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function debugError(err: unknown): void {
  if (process.env.PENUMBRA_T2_CRASH_REPRO_DEBUG !== "1") {
    return;
  }
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
}

function copyLiveDb(): { tempDir: string; dbPath: string } {
  const sourceDb = expandPath(LIVE_DB);
  if (!existsSync(sourceDb)) {
    throw new Error(`live db not found: ${sourceDb}`);
  }
  const tempDir = mkdtempSync(join(tmpdir(), "penumbra-t2-crash-repro-"));
  const targetDb = join(tempDir, "db.sqlite");
  copyFileSync(sourceDb, targetDb);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${sourceDb}${suffix}`;
    if (existsSync(sidecar)) {
      copyFileSync(sidecar, `${targetDb}${suffix}`);
    }
  }
  return { tempDir, dbPath: targetDb };
}

async function createDaemonLikeEmbedder(): Promise<Embedder> {
  const embedderEnv = readEmbedderEnv(process.env) ?? { mode: "auto" as const };
  return await resolveEmbedder({
    mode: embedderEnv.mode,
    remote: embedderEnv.remote,
    fallback: new BundledEmbedder(),
  });
}

function createStubEmbedder(): Embedder {
  return {
    name: "stub-constant-384",
    dim: 384,
    embed(texts: string[]): Promise<Float32Array[]> {
      return Promise.resolve(texts.map(() => new Float32Array(384).fill(0.001)));
    },
  };
}

function latestRollupId(db: Database): string | null {
  return (
    db
      .query<
        { rollup_id: string },
        []
      >("SELECT rollup_id FROM t1_rollups ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 1")
      .get()?.rollup_id ?? null
  );
}

function createUuidSequence(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function lastStdoutLine(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

function parseChildLine(line: string | null): ChildResult | null {
  if (!line) {
    return null;
  }
  let parsed: Partial<ChildResult>;
  try {
    parsed = JSON.parse(line) as Partial<ChildResult>;
  } catch {
    return null;
  }
  if (
    (parsed.outcome === "completed" ||
      parsed.outcome === "judge_failed" ||
      parsed.outcome === "error") &&
    typeof parsed.promoted_count === "number"
  ) {
    return { outcome: parsed.outcome, promoted_count: parsed.promoted_count };
  }
  return null;
}

const REASONING_TAG_PATTERN = /<(?:think|reasoning)>[\s\S]*?<\/(?:think|reasoning)>\s*/gi;

function stripReasoningTags(content: string): string {
  return content.replaceAll(REASONING_TAG_PATTERN, "");
}

// ANSI / bracketed-paste artifacts; constructed from String.fromCharCode so the
// source file does not contain a literal ESC control character.
const ESC = String.fromCharCode(0x1b);
const ANSI_ESC_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const BRACKET_ARTIFACT_PATTERN = /(?:^|\s)\[[0-9;]+[A-Za-z]/g;
const JSON_FENCE_PATTERN = /^```(?:json|JSON)?\n?([\s\S]+?)\n?```$/;

function stripJsonFence(content: string): string {
  const detagged = stripReasoningTags(content).trim();
  if (/^(?:none|null|n\/?a|nothing|empty)\.?$/i.test(detagged)) {
    return '{"memories":[]}';
  }
  const stripped = detagged
    .replaceAll(ANSI_ESC_PATTERN, "")
    .replaceAll(BRACKET_ARTIFACT_PATTERN, " ");
  const fenced = JSON_FENCE_PATTERN.exec(stripped);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return stripped.slice(firstBrace, lastBrace + 1);
  }
  return stripped;
}

function parseJudgeResponse(content: string): T2MemoryExtraction[] {
  let parsed: { memories?: unknown };
  try {
    parsed = JSON.parse(stripJsonFence(content)) as { memories?: unknown };
  } catch {
    return [];
  }
  const extractions = parsed.memories;
  if (!Array.isArray(extractions)) {
    return [];
  }
  return extractions as T2MemoryExtraction[];
}

function expandPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

const REPRO_JUDGE: JudgeEntry = {
  name: "repro-proxy",
  baseUrl: "http://127.0.0.1:7944/v1",
  apiKey: "local-no-auth",
  model: "granite-mini-3b",
};

const quietLog = {
  info: (): undefined => undefined,
  warn: (): undefined => undefined,
  error: (): undefined => undefined,
};

if (import.meta.main) {
  try {
    const args = parseCliArgs(Bun.argv.slice(2));
    if (args.mode === "parent") {
      await runParent(args);
      process.exitCode = 0;
    } else {
      const result = await runChildTick(args.stubEmbed);
      process.stdout.write(JSON.stringify(result) + "\n");
      process.exitCode = result.outcome === "completed" ? 0 : 1;
    }
  } catch {
    if (Bun.argv.includes("--tick")) {
      process.stdout.write(JSON.stringify({ outcome: "error", promoted_count: 0 }) + "\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(buildSummaryLine([]) + "\n");
      process.exitCode = 0;
    }
  }
}
