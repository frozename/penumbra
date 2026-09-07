#!/usr/bin/env bun
/**
 * Gate baseline capture and delta report.
 *
 * Records the REAL state of every blocking gate before a change lands, so a
 * later "no regressions" claim can be diffed against a number that was actually
 * measured rather than remembered.
 *
 * EXIT-CODE DISCIPLINE — the reason this script exists.
 *   Every gate runs as a DIRECT CHILD PROCESS (an argv array handed to
 *   Bun.spawn: no shell, no pipeline) and its exit code is read from that
 *   child. Never run a gate through a pipeline and read `$?`: in a pipeline
 *   `$?` is the LAST command's status, so
 *       bun scripts/bun-test-gate.ts packages/core | tail -20; echo $?
 *   prints tail's 0 and a red shard gets written down as green. That happened
 *   during a hand-run baseline and two failing gates were recorded as passing.
 *   zsh spells the per-stage statuses `$pipestatus` (1-indexed) rather than
 *   `$PIPESTATUS`, which is a second way to get the same answer wrong. There is
 *   no pipeline anywhere in this file — keep it that way.
 *
 * THE TEST GATE IS SHARDED.
 *   Root `bun test` is NOT this repo's gate: it globs every package into one
 *   process and crashes Bun. The gate is one scripts/bun-test-gate.ts shard per
 *   packages/*\/ directory plus a final root shard covering test/ and scripts/,
 *   each carrying the same four --path-ignore-patterns that
 *   .github/workflows/check.yml passes. Packages holding no applicable test
 *   file are SKIPPED, because bun exits non-zero on a filter that matches no
 *   files and that non-zero is not a failing gate.
 *
 * format:check IS NOT CI-GATED.
 *   .github/workflows/check.yml never runs prettier. format:check is captured
 *   anyway because unformatted code fails the commit hook at land time, but it
 *   is recorded with ci_gated: false and labelled NOT-CI-GATED in the delta
 *   table so a red result there is not read as a regression.
 *
 * BLIND SPOT: the console production build (`bun run --cwd packages/console
 * build`), which CI runs inside its blocking console step, is not captured
 * here. A green baseline from this script says nothing about it.
 *
 * Exit codes:
 *   0 — baseline captured, or --compare found no regression
 *   1 — --compare found a regression: a green gate went red, a pass count
 *       dropped, a fail count rose, or an UNSCOPED run lost a gate the
 *       baseline had
 *   2 — usage or IO error (unknown flag, unreadable or malformed baseline)
 *
 * Usage:
 *   bun scripts/gate-baseline.ts > baseline.json
 *   bun scripts/gate-baseline.ts --timestamp 2026-09-07T12:00:00.000Z > baseline.json
 *   bun scripts/gate-baseline.ts --only core,daemon > scoped.json
 *   bun scripts/gate-baseline.ts --compare baseline.json
 *
 * --only runs ONLY the named packages' test shards; the repo-wide gates
 * (typecheck, the coverage ratchet, lint:strict, format:check) and the root
 * shard are skipped, which is the whole point of the flag. A --compare against
 * a scoped baseline therefore reports the absent gates as MISSING rather than
 * as regressions.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { parseBunTestReport } from "../packages/agentchat/src/worker/bun-test-output.js";

/** The four ignore patterns .github/workflows/check.yml passes to every shard. */
export const SHARD_IGNORE_PATTERNS: readonly string[] = [
  "--path-ignore-patterns=**/console/e2e/**",
  "--path-ignore-patterns=**/visual/**",
  "--path-ignore-patterns=**/dist/**",
  "--path-ignore-patterns=**/scripts/bench*.test.ts",
];

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SKIP_WALK_DIRS = new Set([".git", "coverage", "dist", "node_modules"]);

export interface GateCounts {
  pass: number | null;
  fail: number | null;
  skip: number | null;
}

export interface GateSpec {
  name: string;
  argv: string[];
  ciGated: boolean;
  parsesCounts: boolean;
}

export interface GateResult extends GateCounts {
  name: string;
  command: string;
  exit_code: number;
  ok: boolean;
  ci_gated: boolean;
}

export interface GateBaseline {
  base_commit: string;
  captured_at: string;
  worktree_dirty: boolean;
  scoped_to: string[] | null;
  gates: GateResult[];
}

export interface CliOptions {
  comparePath: string | null;
  only: string[] | null;
  timestamp: string | null;
  help: boolean;
}

export type DeltaStatus = "fixed" | "improved" | "missing" | "new" | "regression" | "same";

export interface GateSnapshot {
  exit_code: number;
  ok: boolean;
  ci_gated: boolean;
  pass: number | null;
  fail: number | null;
}

export interface DeltaRow {
  name: string;
  baseline: GateSnapshot | null;
  current: GateSnapshot | null;
  status: DeltaStatus;
  note: string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--compare", "--only", "--timestamp"]);

function applyValueFlag(options: CliOptions, flag: string, value: string): void {
  if (flag === "--compare") {
    options.comparePath = value;
    return;
  }
  if (flag === "--timestamp") {
    options.timestamp = value;
    return;
  }
  options.only = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Rejects anything it does not recognise rather than silently ignoring it. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    comparePath: null,
    only: null,
    timestamp: null,
    help: false,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    index += 1;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new Error(`gate-baseline: unknown argument ${arg}`);
    }
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`gate-baseline: ${arg} requires a value`);
    }
    index += 1;
    applyValueFlag(options, arg, value);
  }
  if (options.only !== null && options.only.length === 0) {
    throw new Error("gate-baseline: --only requires at least one package name");
  }
  return options;
}

// ---------------------------------------------------------------------------
// Gate construction
// ---------------------------------------------------------------------------

function quoteArg(arg: string): string {
  return /^[\w./:=-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Renders an argv array as a copy-pasteable shell command. */
export function formatCommand(argv: readonly string[]): string {
  return argv.map((arg) => quoteArg(arg)).join(" ");
}

function shardSpec(name: string, filterArgs: readonly string[]): GateSpec {
  return {
    name,
    argv: ["bun", "scripts/bun-test-gate.ts", ...filterArgs, ...SHARD_IGNORE_PATTERNS],
    ciGated: true,
    parsesCounts: true,
  };
}

/**
 * `packageDirs` are repo-relative ("packages/core"). When `scoped` is true only
 * the per-package shards are built; see the --only note in the header.
 */
export function buildGateSpecs(
  packageDirs: readonly string[],
  options: { scoped: boolean },
): GateSpec[] {
  const shards = packageDirs.map((dir) => shardSpec(dir, [dir]));
  if (options.scoped) {
    return shards;
  }
  return [
    { name: "typecheck", argv: ["bun", "run", "typecheck"], ciGated: true, parsesCounts: false },
    {
      name: "typecheck-coverage-ratchet",
      argv: ["bun", "scripts/check-typecheck-coverage.ts"],
      ciGated: true,
      parsesCounts: false,
    },
    ...shards,
    shardSpec("root (test/ + scripts/)", ["--path-ignore-patterns=packages/**"]),
    {
      name: "lint:strict",
      argv: ["bun", "run", "lint:strict"],
      ciGated: true,
      parsesCounts: false,
    },
    {
      name: "format:check",
      argv: ["bun", "run", "format:check"],
      ciGated: false,
      parsesCounts: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Reuses the gate's own summary parser (packages/agentchat bun-test-output) for
 * pass/fail so this script and scripts/bun-test-gate.ts can never disagree, and
 * adds the skip count, which that parser does not expose. Every count is null
 * when the output carries no summary — a crashed shard reports nulls, not zeros.
 */
export function parseTestCounts(output: string): GateCounts {
  const report = parseBunTestReport(output);
  if (!report.reachedSummary) {
    return { pass: null, fail: null, skip: null };
  }
  const skipMatches = [...report.output.matchAll(/(\d+)\s+skip\b/g)];
  const skipRaw = skipMatches.at(-1)?.[1];
  return {
    pass: report.pass,
    fail: report.fails,
    skip: skipRaw === undefined ? null : Number(skipRaw),
  };
}

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

/** Mirrors the CI shard's find/grep filter, on a repo-relative path. */
export function isApplicableTestFile(relativePath: string): boolean {
  if (!relativePath.endsWith(".test.ts")) {
    return false;
  }
  const segments = relativePath.split("/");
  if (segments.includes("node_modules") || segments.includes("dist")) {
    return false;
  }
  if (segments.includes("visual") || relativePath.includes("/console/e2e/")) {
    return false;
  }
  return !/^bench.*\.test\.ts$/.test(segments.at(-1) ?? "");
}

function safeReaddir(dir: string): { name: string; directory: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

function hasApplicableTests(root: string, packageDir: string): boolean {
  const stack: string[] = [join(root, packageDir)];
  while (stack.length > 0) {
    const current = stack.pop() ?? "";
    for (const entry of safeReaddir(current)) {
      const full = join(current, entry.name);
      if (entry.directory) {
        if (!SKIP_WALK_DIRS.has(entry.name)) {
          stack.push(full);
        }
      } else if (isApplicableTestFile(relative(root, full))) {
        return true;
      }
    }
  }
  return false;
}

function listPackageDirs(root: string): string[] {
  return safeReaddir(join(root, "packages"))
    .filter((entry) => entry.directory)
    .map((entry) => `packages/${entry.name}`)
    .sort((a, b) => a.localeCompare(b));
}

function normalizePackageName(name: string): string {
  const trimmed = name.replace(/\/+$/, "");
  return trimmed.startsWith("packages/") ? trimmed : `packages/${trimmed}`;
}

function resolvePackageDirs(root: string, only: readonly string[] | null): string[] {
  const all = listPackageDirs(root);
  if (only === null) {
    return all.filter((dir) => hasApplicableTests(root, dir));
  }
  const wanted = only.map((name) => normalizePackageName(name));
  const unknown = wanted.filter((dir) => !all.includes(dir));
  if (unknown.length > 0) {
    throw new Error(`gate-baseline: unknown package(s) in --only: ${unknown.join(", ")}`);
  }
  const withTests = wanted.filter((dir) => hasApplicableTests(root, dir));
  if (withTests.length === 0) {
    throw new Error("gate-baseline: --only selected no package with applicable tests");
  }
  for (const dir of wanted) {
    if (!withTests.includes(dir)) {
      console.error(`gate-baseline: skipping ${dir} (no applicable tests)`);
    }
  }
  return withTests;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(argv: readonly string[], cwd: string): Promise<CommandResult> {
  // Direct child process, argv array, no shell and no pipeline, so the exit
  // code below belongs to THIS command. See the header's exit-code discipline.
  const command = argv[0];
  if (command === undefined) {
    throw new Error("gate-baseline: refusing to run an empty command");
  }
  const child = Bun.spawn([command, ...argv.slice(1)], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function runGate(spec: GateSpec, root: string): Promise<GateResult> {
  const command = formatCommand(spec.argv);
  process.stderr.write(`gate-baseline: running ${spec.name} -> ${command}\n`);
  const result = await runCommand(spec.argv, root);
  const counts = spec.parsesCounts
    ? parseTestCounts(result.stdout + result.stderr)
    : { pass: null, fail: null, skip: null };
  process.stderr.write(`gate-baseline: ${spec.name} exit ${String(result.code)}\n`);
  return {
    name: spec.name,
    command,
    exit_code: result.code,
    ok: result.code === 0,
    ci_gated: spec.ciGated,
    ...counts,
  };
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], root);
  if (result.code !== 0) {
    throw new Error(
      `gate-baseline: git ${args.join(" ")} failed (exit ${String(result.code)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function captureBaseline(root: string, options: CliOptions): Promise<GateBaseline> {
  const packageDirs = resolvePackageDirs(root, options.only);
  const specs = buildGateSpecs(packageDirs, { scoped: options.only !== null });
  const baseCommit = await gitOutput(root, ["rev-parse", "HEAD"]);
  const capturedAt =
    options.timestamp ?? (await gitOutput(root, ["show", "-s", "--format=%cI", "HEAD"]));
  const dirty = await gitOutput(root, ["status", "--porcelain"]);
  const gates: GateResult[] = [];
  for (const spec of specs) {
    // Sequential on purpose: concurrent shards contend for CPU and for the
    // repo's build outputs, and a baseline measured under contention is not the
    // baseline the next run reproduces.
    gates.push(await runGate(spec, root));
  }
  return {
    base_commit: baseCommit,
    captured_at: capturedAt,
    worktree_dirty: dirty.length > 0,
    scoped_to: options.only,
    gates,
  };
}

// ---------------------------------------------------------------------------
// Baseline file parsing
// ---------------------------------------------------------------------------

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`gate-baseline: ${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`gate-baseline: ${context}.${key} must be a string`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`gate-baseline: ${context}.${key} must be a number`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, context: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`gate-baseline: ${context}.${key} must be a boolean`);
  }
  return value;
}

function nullableNumber(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error(`gate-baseline: ${context}.${key} must be a number or null`);
  }
  return value;
}

function requireGateResult(value: unknown, context: string): GateResult {
  const record = requireRecord(value, context);
  return {
    name: requireString(record, "name", context),
    command: requireString(record, "command", context),
    exit_code: requireNumber(record, "exit_code", context),
    ok: requireBoolean(record, "ok", context),
    ci_gated: requireBoolean(record, "ci_gated", context),
    pass: nullableNumber(record, "pass", context),
    fail: nullableNumber(record, "fail", context),
    skip: nullableNumber(record, "skip", context),
  };
}

function readScopedTo(record: Record<string, unknown>): string[] | null {
  const value = record["scoped_to"];
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("gate-baseline: baseline.scoped_to must be an array or null");
  }
  const entries = value as unknown[];
  return entries.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`gate-baseline: baseline.scoped_to[${String(index)}] must be a string`);
    }
    return entry;
  });
}

/** Fails closed on a malformed baseline rather than comparing against nothing. */
export function parseBaselineJson(text: string): GateBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("gate-baseline: baseline file is not valid JSON");
  }
  const record = requireRecord(parsed, "baseline");
  const gatesValue = record["gates"];
  if (!Array.isArray(gatesValue)) {
    throw new Error("gate-baseline: baseline.gates must be an array");
  }
  const gateEntries = gatesValue as unknown[];
  return {
    base_commit: requireString(record, "base_commit", "baseline"),
    captured_at: requireString(record, "captured_at", "baseline"),
    worktree_dirty: requireBoolean(record, "worktree_dirty", "baseline"),
    scoped_to: readScopedTo(record),
    gates: gateEntries.map((gate, index) =>
      requireGateResult(gate, `baseline.gates[${String(index)}]`),
    ),
  };
}

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

function toSnapshot(gate: GateResult): GateSnapshot {
  return {
    exit_code: gate.exit_code,
    ok: gate.ok,
    ci_gated: gate.ci_gated,
    pass: gate.pass,
    fail: gate.fail,
  };
}

/**
 * A count moving the wrong way. Fail is checked before pass: a red shard that
 * added tests AND broke more would otherwise read the pass rise as an
 * improvement and report exit 0.
 */
function classifyCountRegression(
  before: GateSnapshot,
  after: GateSnapshot,
): { status: DeltaStatus; note: string } | null {
  if (before.fail !== null && after.fail !== null && after.fail > before.fail) {
    return {
      status: "regression",
      note: `fail count rose ${String(before.fail)} -> ${String(after.fail)}`,
    };
  }
  if (before.pass !== null && after.pass !== null && after.pass < before.pass) {
    return {
      status: "regression",
      note: `pass count dropped ${String(before.pass)} -> ${String(after.pass)}`,
    };
  }
  return null;
}

/** A count moving the right way. Only consulted once no regression applies. */
function classifyCountImprovement(
  before: GateSnapshot,
  after: GateSnapshot,
): { status: DeltaStatus; note: string } | null {
  if (before.fail !== null && after.fail !== null && after.fail < before.fail) {
    return {
      status: "improved",
      note: `fail count dropped ${String(before.fail)} -> ${String(after.fail)}`,
    };
  }
  if (before.pass !== null && after.pass !== null && after.pass > before.pass) {
    return {
      status: "improved",
      note: `pass count rose ${String(before.pass)} -> ${String(after.pass)}`,
    };
  }
  return null;
}

function classify(
  before: GateSnapshot,
  after: GateSnapshot,
): { status: DeltaStatus; note: string } {
  if (before.ok && !after.ok) {
    return { status: "regression", note: `green -> exit ${String(after.exit_code)}` };
  }
  if (!before.ok && after.ok) {
    return { status: "fixed", note: `exit ${String(before.exit_code)} -> green` };
  }
  return (
    classifyCountRegression(before, after) ??
    classifyCountImprovement(before, after) ?? {
      status: "same",
      note: before.ok ? "green, unchanged" : "red, unchanged",
    }
  );
}

function classifyMissing(scoped: boolean): { status: DeltaStatus; note: string } {
  // A gate the baseline measured and this run did not is a hole, not a pass —
  // unless --only deliberately scoped it out, which is the flag's whole purpose.
  return scoped
    ? { status: "missing", note: "not run (scoped by --only)" }
    : { status: "regression", note: "gate in the baseline was not run" };
}

/**
 * Ordered baseline-first so the table reads as the baseline plus whatever the
 * current run added. `scoped` must be true when the current run used --only.
 */
export function computeDelta(
  baseline: readonly GateResult[],
  current: readonly GateResult[],
  options: { scoped: boolean },
): DeltaRow[] {
  const currentByName = new Map(current.map((gate) => [gate.name, gate]));
  const rows: DeltaRow[] = [];
  for (const before of baseline) {
    const after = currentByName.get(before.name);
    const beforeSnapshot = toSnapshot(before);
    const verdict =
      after === undefined
        ? classifyMissing(options.scoped)
        : classify(beforeSnapshot, toSnapshot(after));
    rows.push({
      name: before.name,
      baseline: beforeSnapshot,
      current: after === undefined ? null : toSnapshot(after),
      status: verdict.status,
      note: verdict.note,
    });
  }
  const baselineNames = new Set(baseline.map((gate) => gate.name));
  for (const after of current) {
    if (baselineNames.has(after.name)) {
      continue;
    }
    rows.push({
      name: after.name,
      baseline: null,
      current: toSnapshot(after),
      status: "new",
      note: "not present in the baseline",
    });
  }
  return rows;
}

/** Green went red, a count moved the wrong way, or an unscoped run lost a gate. */
export function deltaExitCode(rows: readonly DeltaRow[]): number {
  return rows.some((row) => row.status === "regression") ? 1 : 0;
}

function formatSnapshot(snapshot: GateSnapshot | null): string {
  if (snapshot === null) {
    return "-";
  }
  if (snapshot.pass === null) {
    return `exit ${String(snapshot.exit_code)}`;
  }
  return `exit ${String(snapshot.exit_code)} ${String(snapshot.pass)}p/${String(snapshot.fail ?? 0)}f`;
}

function renderTable(cellRows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const cells of cellRows) {
    for (const [index, cell] of cells.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    }
  }
  return cellRows
    .map((cells) =>
      cells
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatDeltaTable(rows: readonly DeltaRow[]): string {
  const cellRows: string[][] = [["gate", "baseline", "now", "status", "note"]];
  for (const row of rows) {
    const label = row.current?.ci_gated === false || row.baseline?.ci_gated === false;
    cellRows.push([
      row.name,
      formatSnapshot(row.baseline),
      formatSnapshot(row.current),
      row.status.toUpperCase(),
      label ? `${row.note} [NOT-CI-GATED]` : row.note,
    ]);
  }
  return renderTable(cellRows);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = [
  "usage: bun scripts/gate-baseline.ts [--only <pkg,pkg>] [--timestamp <iso>] > baseline.json",
  "       bun scripts/gate-baseline.ts --compare <baseline.json> [--only <pkg,pkg>]",
].join("\n");

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function runCompare(root: string, options: CliOptions, comparePath: string): Promise<number> {
  let baseline: GateBaseline;
  try {
    baseline = parseBaselineJson(readFileSync(comparePath, "utf8"));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const current = await captureBaseline(root, options);
  const rows = computeDelta(baseline.gates, current.gates, { scoped: options.only !== null });
  process.stdout.write(
    `baseline ${baseline.base_commit.slice(0, 8)} (${baseline.captured_at}) vs now ${current.base_commit.slice(0, 8)} (${current.captured_at})\n\n`,
  );
  process.stdout.write(`${formatDeltaTable(rows)}\n`);
  return deltaExitCode(rows);
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  try {
    if (options.comparePath !== null) {
      process.exit(await runCompare(REPO_ROOT, options, options.comparePath));
    }
    const baseline = await captureBaseline(REPO_ROOT, options);
    process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  void main();
}
