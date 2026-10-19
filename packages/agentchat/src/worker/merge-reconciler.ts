// Contract acceptance probe 2026-08-27: verified status round-trips.
import * as core from "@penumbra/core";
import {
  type HandoffRow,
  ISOLATED_INSTALL_CACHE_KEY,
  type Logger,
  type Settings,
  type WorktreeCommandRunner,
  type WorktreeCommandRunnerOptions,
  type WorktreeHandle,
  type WorktreeManager,
} from "@penumbra/core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { RuntimeThoughtsConfig } from "./thought-config.js";

import { PenumbraHttpError } from "../penumbra-client.js";
import { scopeDiffToPackages } from "./affected-packages.js";
import {
  type BunTestReport,
  isKnownBunTeardownPanicPass,
  parseBunTestReport,
} from "./bun-test-output.js";
import { createDispatchPR, renderDispatchPRBody } from "./github-pr-helper.js";
import {
  runThoughtAnalyzer,
  type ThoughtAnalyzerDeps,
  type ThoughtRow,
} from "./thought-analyzer.js";

export const MERGE_RESULT_STATUSES = Object.freeze([
  "merged",
  "rebased",
  "rebase_conflict",
  "verified",
  "test_failed",
  "typecheck_failed",
  "pr_opened",
  "pr_creation_failed",
  "no_changes",
] as const);

export interface MergeResult {
  status: (typeof MERGE_RESULT_STATUSES)[number];
  progressReported?: boolean;
  conflict_files?: string[];
  regression_summary?: string;
  timed_out?: boolean;
  worktree_dirty?: boolean;
  pr_url?: string;
  pr_number?: number;
  error_code?: "invalid_branch_base" | "invalid_branch" | "invalid_test_package_path";
  verification_environment_error?: true;
}

type CheckStatus = "pass" | "fail" | "skipped" | "error";

export interface ReconcilerVerdict {
  handoff_id: string;
  conversation_id: string;
  branch: string;
  head_sha: string;
  base_sha: string;
  typecheck: CheckStatus;
  tests: CheckStatus;
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  ff_mergeable: boolean;
  rebase_required: boolean;
  rebase_attempted: boolean;
  rebase_result: "success" | "conflict" | "skipped" | "success_local_only";
  rebase_conflict_files?: string[];
  rebased_branch?: string;
  pr_url: string | null;
  verified_at: string;
  duration_ms: number;
  summary: string;
  progressReported?: boolean;
}

class Mutex {
  private last: Promise<void> = Promise.resolve();

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.last;
    let release!: () => void;
    this.last = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
    } catch {
      // swallow upstream errors so we still acquire
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const globalMergeLock = new Mutex();
const testBaselineCache = new Map<string, Promise<BunTestCommandOutcome>>();

export interface ReconcilerDeps {
  worktreeManager: WorktreeManager;
  postProgress: (handoffId: string, payload: Record<string, unknown>) => Promise<void>;
  notifyResult?: (handoffId: string, result: MergeResult) => Promise<void> | void;
  captureResult?: (handoffId: string, result: MergeResult) => Promise<void> | void;
  emitVerdict?: (verdict: ReconcilerVerdict) => Promise<void> | void;
  log: Logger;
  mainRepoDir: string;
  reconcilerAutoRebase?: boolean;
  rebaseScratchRoot?: string;
  getHandoff: (handoffId: string) => Promise<HandoffRow | null>;
  createDispatchPR?: typeof createDispatchPR;
  exec?: (
    argv: string[],
    options: ReconcilerExecOptions,
  ) => Promise<{ stdout: string; stderr: string }>;
  thoughtsConfig?: RuntimeThoughtsConfig;
  thoughtAnalyzerDeps?: ThoughtAnalyzerDeps;
  runThoughtAnalyzer?: typeof runThoughtAnalyzer;
  listThoughtEvents?: (handoffId: string) => Promise<ThoughtRow[]>;
  getParentHandoffId?: (handoffId: string) => Promise<string | null>;
  settings?: Pick<Settings, "reconcileTypecheckTimeoutSec" | "reconcileTestTimeoutSec">;
}

type ReconcilerExecOptions = Pick<
  WorktreeCommandRunnerOptions,
  "cwd" | "timeout" | "maxBuffer" | "encoding" | "signal" | "env" | "stdio"
> & { cwd: string };

type CoreIsolatedProvisioning = typeof core & {
  ISOLATED_INSTALL_CACHE_KEY?: string;
  prepareEscapingFileDependencyLinks: (mainRepoRoot: string, worktreeRoot: string) => void;
  provisionLocalCache: (mainRepoRoot: string, worktreeRoot: string) => void;
  materializeWorkspaceLinks: (worktreeRoot: string) => void;
  runIsolatedInstall: (
    wtPath: string,
    opts?: { runner?: WorktreeCommandRunner; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<void>;
};

interface RebaseOutcome {
  attempted: boolean;
  result: "success" | "conflict" | "skipped" | "success_local_only";
  conflictFiles?: string[];
  rebasedBranch?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface BunTestCommandOutcome {
  timedOut: boolean;
  envFailure: boolean;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  report: BunTestReport;
}

interface CommandRun {
  promise: Promise<CommandResult>;
  cancel: () => void;
}

type CommandArgs = [string, ...string[]];

const REF_TOKEN_RE = /^[A-Za-z0-9._/^~-]{1,200}$/;
const TEST_PACKAGE_PATH_RE = /^[a-zA-Z0-9._/-]{1,200}$/;
const PACKAGE_ROOT_RE = /^[a-zA-Z0-9._/-]{1,200}$/;

function hasForbiddenRefChars(value: string): boolean {
  return value.includes("\0") || value.includes("\n") || value.includes("\r");
}

function isValidGitRefToken(token: string): boolean {
  if (token.length === 0 || token.length > 200) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("../")) return false;
  if (token.includes("..")) return false;
  if (hasForbiddenRefChars(token)) return false;
  return REF_TOKEN_RE.test(token);
}

function isValidGitRef(ref: string): boolean {
  const value = ref.trim();
  if (value.length === 0) return false;
  if (value.startsWith("--")) return false;
  if (hasForbiddenRefChars(value)) return false;

  const tripleIdx = value.indexOf("...");
  if (tripleIdx !== -1) {
    if (tripleIdx !== value.lastIndexOf("...")) return false;
    const left = value.slice(0, tripleIdx);
    const right = value.slice(tripleIdx + 3);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  const doubleIdx = value.indexOf("..");
  if (doubleIdx !== -1) {
    if (doubleIdx !== value.lastIndexOf("..")) return false;
    const left = value.slice(0, doubleIdx);
    const right = value.slice(doubleIdx + 2);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  return isValidGitRefToken(value);
}

function isValidTestPackagePath(path: string): boolean {
  if (!TEST_PACKAGE_PATH_RE.test(path)) return false;
  if (path.includes("..")) return false;
  if (path.startsWith("-")) return false;
  if (path.split("/").some((segment) => segment.startsWith("-"))) return false;
  return true;
}

function isValidPackageRoot(path: string): boolean {
  if (!PACKAGE_ROOT_RE.test(path)) return false;
  if (path.includes("..")) return false;
  if (!path.startsWith("packages/")) return false;
  if (path.split("/").some((segment) => segment.startsWith("-"))) return false;
  return true;
}

class CommandFailure extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(opts: { message: string; exitCode: number | null; stdout: string; stderr: string }) {
    super(opts.message);
    this.name = "CommandFailure";
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
  }
}

interface CommandErrorInfo {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function commandErrorInfo(err: unknown): CommandErrorInfo {
  if (err instanceof CommandFailure) {
    return {
      exitCode: err.exitCode ?? -1,
      stdout: err.stdout,
      stderr: err.stderr,
    };
  }
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      exitCode: typeof e.code === "number" ? e.code : -1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
  return { exitCode: -1, stdout: "", stderr: "" };
}

// Empty stdout and stderr means verification never produced a real diagnostic
// signal; treat it as an environment fault, not dispatched-code failure.
function isVerificationEnvironmentFailure(info: CommandErrorInfo): boolean {
  return info.stdout.trim() === "" && info.stderr.trim() === "";
}

/** Small wrapper so command construction stays type-safe at call sites. */
function toCommandArgs(file: string, args: string[]): CommandArgs {
  return [file, ...args];
}

function noop(): void {
  // intentionally empty: used as a cancel-shim when the command is mocked
}

/**
 * Runs a command with a timeout. If it times out, kills the process group.
 */
function startCommand(
  argv: CommandArgs,
  cwd: string,
  log: Logger,
  execFn?: ReconcilerDeps["exec"],
): CommandRun {
  const [file, ...args] = argv;
  const commandText = argv.join(" ");
  if (execFn) {
    return {
      promise: execFn(argv, { cwd }),
      cancel: noop,
    };
  }

  const proc = spawn(file, args, {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  return {
    promise: new Promise<CommandResult>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new CommandFailure({
              message: `Command failed with code ${String(code)}: ${commandText}`,
              exitCode: code,
              stdout,
              stderr,
            }),
          );
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    }),
    cancel: (): void => {
      log.warn({ cmd: commandText, pid: proc.pid }, "command timed out, killing process group");
      if (!proc.pid) return;
      try {
        if (process.platform !== "win32") {
          process.kill(-proc.pid, "SIGKILL");
        } else {
          proc.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
    },
  };
}

async function runCommand(
  argv: CommandArgs,
  cwd: string,
  log: Logger,
  exec: ReconcilerDeps["exec"],
  timeoutSeconds?: number,
): Promise<CommandResult & { timedOut?: boolean }> {
  const run = startCommand(argv, cwd, log, exec);
  if (!timeoutSeconds) {
    return await run.promise;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      run.cancel();
      resolve({ stdout: "", stderr: "", timedOut: true });
    }, timeoutSeconds * 1000);

    run.promise.then(
      (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(res);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function parseShortStat(shortStat: string): {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
} {
  const filesChangedMatch = /(\d+)\s+files?\s+changed/.exec(shortStat);
  const linesAddedMatch = /(\d+)\s+insertions?\(\+\)/.exec(shortStat);
  const linesDeletedMatch = /(\d+)\s+deletions?\(-\)/.exec(shortStat);
  const pickCount = (m: RegExpExecArray | null): number => {
    const raw = m?.[1];
    return raw === undefined ? 0 : Number.parseInt(raw, 10);
  };
  return {
    filesChanged: pickCount(filesChangedMatch),
    linesAdded: pickCount(linesAddedMatch),
    linesDeleted: pickCount(linesDeletedMatch),
  };
}

interface TypecheckDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

const TYPECHECK_ERROR_RE = /^([^\s:(]+\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(\S.*)$/gm;

function parseTypecheckDiagnostics(output: string): TypecheckDiagnostic[] {
  const diagnostics: TypecheckDiagnostic[] = [];
  TYPECHECK_ERROR_RE.lastIndex = 0;
  for (const match of output.matchAll(TYPECHECK_ERROR_RE)) {
    const [, file, line, col, code, message] = match;
    if (!file || !line || !col || !code || !message) continue;
    diagnostics.push({
      file,
      line: Number.parseInt(line, 10),
      col: Number.parseInt(col, 10),
      code,
      message,
    });
  }
  return diagnostics;
}

function formatTypecheckDiagnostics(diagnostics: TypecheckDiagnostic[]): string {
  const visible = diagnostics
    .slice(0, 20)
    .map(
      (diag) =>
        `${diag.file}:${String(diag.line)}:${String(diag.col)} ${diag.code}: ${diag.message}`,
    );
  if (diagnostics.length > 20) {
    visible.push(`... (${String(diagnostics.length - 20)} more)`);
  }
  return visible.join("\n");
}

interface WorkspacePackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ReconcileState {
  typecheckStatus: CheckStatus;
  testStatus: CheckStatus;
  diffStats: { filesChanged: number; linesAdded: number; linesDeleted: number };
  rebaseOutcome: RebaseOutcome;
  affectedPackages: string[] | null;
  deletedPackages: string[];
  packagesToBuild: string[] | null;
  changedFiles: Set<string>;
  runRootTestShard: boolean;
  testCommandUsed: string;
}

interface ReconcileSnapshot {
  baseTipSha: string;
  branchHeadSha: string;
  mergeBaseSha: string;
  diffSpec: string;
}

interface ReconcileCtx {
  deps: ReconcilerDeps;
  handoffId: string;
  handoff: HandoffRow | null;
  wt: WorktreeHandle;
  baseRef: string;
  snapshot: ReconcileSnapshot | null;
  startedAtMs: number;
  packageJsonCache: Map<string, WorkspacePackageJson | null>;
  state: ReconcileState;
}

type CmdResultWithTimeout = CommandResult & { timedOut?: boolean };

async function execCmd(
  ctx: ReconcileCtx,
  argv: CommandArgs,
  cwd: string,
  timeoutSeconds?: number,
): Promise<CmdResultWithTimeout> {
  return await runCommand(argv, cwd, ctx.deps.log, ctx.deps.exec, timeoutSeconds);
}

async function execGit(
  ctx: ReconcileCtx,
  args: string[],
  cwd: string,
  timeoutSeconds?: number,
): Promise<CmdResultWithTimeout> {
  return await execCmd(ctx, toCommandArgs("git", args), cwd, timeoutSeconds);
}

async function execGitSafe(
  ctx: ReconcileCtx,
  args: string[],
  cwd: string,
): Promise<CmdResultWithTimeout | null> {
  try {
    return await execGit(ctx, args, cwd);
  } catch {
    return null;
  }
}

interface GitProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Probe variant that returns the process exit code so callers can distinguish
// "command ran and reported the expected non-zero answer" (e.g. is-ancestor → 1)
// from "command errored out" (e.g. unknown ref → 128). Returns exitCode = -1
// when the underlying error has no numeric code attached (rare; mostly test mocks).
async function execGitProbe(
  ctx: ReconcileCtx,
  args: string[],
  cwd: string,
): Promise<GitProbeResult> {
  try {
    const res = await execGit(ctx, args, cwd);
    return { exitCode: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err: unknown) {
    return commandErrorInfo(err);
  }
}

function requireSnapshot(ctx: ReconcileCtx): ReconcileSnapshot {
  if (!ctx.snapshot) {
    throw new Error("reconcile snapshot has not been resolved");
  }
  return ctx.snapshot;
}

async function resolveReconcileSnapshot(ctx: ReconcileCtx): Promise<void> {
  const { deps, baseRef, wt } = ctx;
  const branchHeadRes = await execGit(ctx, ["rev-parse", "HEAD"], wt.path);
  const branchHeadSha = branchHeadRes.stdout.trim();
  const baseTipRes = await execGit(ctx, ["rev-parse", baseRef], deps.mainRepoDir);
  const baseTipSha = baseTipRes.stdout.trim();
  const mergeBaseRes = await execGit(
    ctx,
    ["merge-base", baseTipSha, branchHeadSha],
    deps.mainRepoDir,
  );
  const mergeBaseSha = mergeBaseRes.stdout.trim();

  if (!branchHeadSha || !baseTipSha || !mergeBaseSha) {
    throw new Error(`unable to resolve reconcile snapshot for ${wt.branchName} against ${baseRef}`);
  }

  ctx.snapshot = {
    baseTipSha,
    branchHeadSha,
    mergeBaseSha,
    diffSpec: `${mergeBaseSha}...${branchHeadSha}`,
  };
}

async function refreshSnapshotFromDurableBranch(ctx: ReconcileCtx): Promise<void> {
  const { deps, baseRef, wt } = ctx;
  const current = requireSnapshot(ctx);
  const branchHeadRes = await execGitSafe(ctx, ["rev-parse", wt.branchName], deps.mainRepoDir);
  const branchHeadSha = branchHeadRes?.stdout.trim();
  if (!branchHeadSha) return;
  const mergeBaseRes = await execGitSafe(
    ctx,
    ["merge-base", current.baseTipSha, branchHeadSha],
    deps.mainRepoDir,
  );
  const mergeBaseSha = mergeBaseRes?.stdout.trim();
  if (!mergeBaseSha) return;
  ctx.snapshot = {
    ...current,
    branchHeadSha,
    mergeBaseSha,
    diffSpec: `${mergeBaseSha}...${branchHeadSha}`,
  };
}

async function readWorkspacePackageJson(
  ctx: ReconcileCtx,
  packageRoot: string,
): Promise<{ pkgJson: WorkspacePackageJson | null; canonicalName: string }> {
  const { packageJsonCache, deps, handoffId, wt } = ctx;
  if (packageJsonCache.has(packageRoot)) {
    const cached = packageJsonCache.get(packageRoot) ?? null;
    return {
      pkgJson: cached,
      canonicalName: cached?.name ?? packageRoot.slice("packages/".length),
    };
  }
  try {
    const body = await readFile(join(wt.path, packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(body) as WorkspacePackageJson;
    packageJsonCache.set(packageRoot, parsed);
    if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
      deps.log.warn(
        { handoffId, path: join(wt.path, packageRoot, "package.json") },
        "workspace package missing name field; falling back to folder name",
      );
    }
    return {
      pkgJson: parsed,
      canonicalName: parsed.name ?? packageRoot.slice("packages/".length),
    };
  } catch (err) {
    packageJsonCache.set(packageRoot, null);
    deps.log.error(
      { handoffId, path: join(wt.path, packageRoot, "package.json"), err: String(err) },
      "workspace package manifest missing or invalid; treating package as affected",
    );
    return {
      pkgJson: null,
      canonicalName: packageRoot.slice("packages/".length),
    };
  }
}

interface AffectedClosure {
  prefixes: string[];
  packages: string[];
}

interface TypeScriptProjectConfig {
  references?: { path?: unknown }[];
}

interface ResolvedTypeScriptProjectReference {
  configPath: string;
  packageRoot: string | null;
}

async function readTypeScriptProjectReferencePaths(configPath: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as TypeScriptProjectConfig;
  return (parsed.references ?? []).flatMap((reference) =>
    typeof reference.path === "string" && reference.path.trim() !== "" ? [reference.path] : [],
  );
}

function resolveTypeScriptProjectReference(
  worktreePath: string,
  configPath: string,
  referencePath: string,
): ResolvedTypeScriptProjectReference {
  const referencedPath = resolve(dirname(configPath), referencePath);
  const referencesConfigFile = referencedPath.endsWith(".json");
  const projectDir = referencesConfigFile ? dirname(referencedPath) : referencedPath;
  const relativeProjectDir = relative(worktreePath, projectDir);
  const packageRoot =
    relativeProjectDir.startsWith("packages/") && !relativeProjectDir.includes("..")
      ? relativeProjectDir
      : null;
  return {
    configPath: referencesConfigFile ? referencedPath : join(referencedPath, "tsconfig.json"),
    packageRoot,
  };
}

async function discoverRootBuildPackageRoots(ctx: ReconcileCtx): Promise<string[] | null> {
  const rootConfigPath = join(ctx.wt.path, "tsconfig.json");
  const pending = [rootConfigPath];
  const visited = new Set<string>();
  const packageRoots = new Set<string>();
  try {
    while (pending.length > 0) {
      const configPath = pending.shift();
      if (!configPath || visited.has(configPath)) continue;
      visited.add(configPath);
      const referencePaths = await readTypeScriptProjectReferencePaths(configPath);
      for (const referencePath of referencePaths) {
        const reference = resolveTypeScriptProjectReference(ctx.wt.path, configPath, referencePath);
        if (reference.packageRoot) packageRoots.add(reference.packageRoot);
        pending.push(reference.configPath);
      }
    }
    return Array.from(packageRoots).sort();
  } catch (err) {
    ctx.deps.log.warn(
      { handoffId: ctx.handoffId, path: rootConfigPath, err: String(err) },
      "root TypeScript build graph discovery failed, using fallback package list",
    );
    return null;
  }
}

async function discoverWorkspacePackageRoots(ctx: ReconcileCtx): Promise<string[]> {
  const fallbackWorkspacePackageRoots = [
    "packages/agentchat",
    "packages/cli",
    "packages/core",
    "packages/daemon",
    "packages/mcp",
    "packages/workflows",
  ];
  const rootBuildPackageRoots = await discoverRootBuildPackageRoots(ctx);
  if (rootBuildPackageRoots && rootBuildPackageRoots.length > 0) {
    return rootBuildPackageRoots;
  }
  try {
    const packageDirEntries = await readdir(join(ctx.wt.path, "packages"), {
      withFileTypes: true,
    });
    const candidates = await Promise.all(
      packageDirEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const packageRoot = `packages/${entry.name}`;
          try {
            await stat(join(ctx.wt.path, packageRoot, "package.json"));
            return packageRoot;
          } catch {
            return null;
          }
        }),
    );
    return candidates.filter((root): root is string => root !== null).sort();
  } catch {
    ctx.deps.log.warn(
      { handoffId: ctx.handoffId, path: ctx.wt.path },
      "workspace package discovery failed, using fallback list",
    );
    return fallbackWorkspacePackageRoots;
  }
}

function isWorkspaceDep(depName: string, depVersion: string): boolean {
  return (
    depVersion === "workspace:*" ||
    depVersion === "*" ||
    depVersion.startsWith("workspace:") ||
    depName.startsWith("@penumbra/")
  );
}

function collectPackageDeps(pkgJson: WorkspacePackageJson): [string, string][] {
  return [
    ...Object.entries(pkgJson.dependencies ?? {}),
    ...Object.entries(pkgJson.devDependencies ?? {}),
  ];
}

function addReverseDep(
  reverseDeps: Map<string, Set<string>>,
  depRoot: string,
  pkgPrefix: string,
): void {
  let dependents = reverseDeps.get(depRoot);
  if (!dependents) {
    dependents = new Set<string>();
    reverseDeps.set(depRoot, dependents);
  }
  dependents.add(pkgPrefix);
}

function indexPackageReverseDeps(
  packageRoot: string,
  pkgJson: WorkspacePackageJson,
  workspacePackageNames: Map<string, string>,
  reverseDeps: Map<string, Set<string>>,
): void {
  const pkgPrefix = `${packageRoot}/`;
  for (const [depName, depVersion] of collectPackageDeps(pkgJson)) {
    const depRoot = workspacePackageNames.get(depName);
    if (!depRoot) continue;
    if (!isWorkspaceDep(depName, depVersion)) continue;
    addReverseDep(reverseDeps, depRoot, pkgPrefix);
  }
}

function indexReverseDeps(
  pkgJsons: { packageRoot: string; pkgJson: WorkspacePackageJson | null }[],
  workspacePackageNames: Map<string, string>,
): { reverseDeps: Map<string, Set<string>>; malformed: Set<string> } {
  const reverseDeps = new Map<string, Set<string>>();
  const malformed = new Set<string>();
  for (const { packageRoot, pkgJson } of pkgJsons) {
    if (!pkgJson) {
      malformed.add(packageRoot);
      continue;
    }
    indexPackageReverseDeps(packageRoot, pkgJson, workspacePackageNames, reverseDeps);
  }
  return { reverseDeps, malformed };
}

function expandClosureBfs(
  seedPackages: readonly string[],
  reverseDeps: Map<string, Set<string>>,
): { closure: Set<string>; buildPackages: Set<string> } {
  const closure = new Set<string>(seedPackages.map((pkg) => `${pkg}/`));
  const buildPackages = new Set<string>(seedPackages);
  const queue = [...seedPackages];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const packageRoot = queue.shift();
    if (packageRoot === undefined) break;
    const dependents = reverseDeps.get(packageRoot);
    if (!dependents) continue;
    for (const dependentPrefix of dependents) {
      const dependentRoot = dependentPrefix.slice(0, -1);
      if (visited.has(dependentRoot)) continue;
      visited.add(dependentRoot);
      closure.add(dependentPrefix);
      buildPackages.add(dependentRoot);
      queue.push(dependentRoot);
    }
  }
  return { closure, buildPackages };
}

async function loadWorkspacePackageJsons(
  ctx: ReconcileCtx,
  workspacePackageRoots: readonly string[],
): Promise<
  {
    packageRoot: string;
    pkgJson: WorkspacePackageJson | null;
    canonicalName: string;
  }[]
> {
  return await Promise.all(
    workspacePackageRoots.map(async (packageRoot) => {
      const { pkgJson, canonicalName } = await readWorkspacePackageJson(ctx, packageRoot);
      return { packageRoot, pkgJson, canonicalName };
    }),
  );
}

async function computeAffectedPackageClosure(ctx: ReconcileCtx): Promise<AffectedClosure> {
  const { affectedPackages, deletedPackages } = ctx.state;
  // A deleted package's dependents cannot be found through its removed
  // package.json, so a deletion attributes every package diagnostic.
  if (affectedPackages === null || deletedPackages.length > 0) {
    return { prefixes: ["packages/"], packages: [] };
  }
  if (affectedPackages.length === 0) {
    return { prefixes: [], packages: [] };
  }

  const workspacePackageRoots = await discoverWorkspacePackageRoots(ctx);
  const pkgJsons = await loadWorkspacePackageJsons(ctx, workspacePackageRoots);

  const workspacePackageNames = new Map<string, string>();
  for (const { packageRoot, canonicalName } of pkgJsons) {
    workspacePackageNames.set(canonicalName, packageRoot);
  }

  const { reverseDeps, malformed } = indexReverseDeps(pkgJsons, workspacePackageNames);
  const { closure, buildPackages } = expandClosureBfs(affectedPackages, reverseDeps);

  for (const packageRoot of malformed) {
    closure.add(`${packageRoot}/`);
    buildPackages.add(packageRoot);
  }

  return {
    prefixes: Array.from(closure).sort(),
    packages: Array.from(buildPackages).sort(),
  };
}

async function rebaseInScratch(ctx: ReconcileCtx, scratchPath: string): Promise<RebaseOutcome> {
  const { wt, baseRef, handoffId, deps } = ctx;
  const snapshot = requireSnapshot(ctx);
  await execGit(
    ctx,
    ["worktree", "add", "--detach", scratchPath, snapshot.baseTipSha],
    deps.mainRepoDir,
  );
  await execGit(ctx, ["checkout", wt.branchName], scratchPath);
  try {
    await execGit(ctx, ["rebase", snapshot.baseTipSha], scratchPath);
  } catch {
    const conflictRes = await execGitSafe(
      ctx,
      ["diff", "--name-only", "--diff-filter=U"],
      scratchPath,
    );
    const files =
      conflictRes?.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean) ?? [];
    await execGitSafe(ctx, ["rebase", "--abort"], scratchPath);
    return { attempted: true, result: "conflict", conflictFiles: files };
  }

  const rebasedTip = (await execGit(ctx, ["rev-parse", wt.branchName], scratchPath)).stdout.trim();
  await execGit(ctx, ["merge-base", "--is-ancestor", snapshot.baseTipSha, rebasedTip], scratchPath);
  if (baseRef !== "main") {
    // Guard: only force-push when baseRef is the canonical main branch.
    // Pushing a rebase against a non-main base could silently rewrite a
    // sibling agent/stage branch on origin (the old behavior hardcoded
    // 'main', which rebased onto main regardless of the intended base).
    deps.log.info(
      { handoffId, baseRef, branch: wt.branchName },
      "auto-rebase succeeded locally; skipping force-push because baseRef is not main",
    );
    return { attempted: true, result: "success_local_only", rebasedBranch: wt.branchName };
  }
  try {
    await execGit(
      ctx,
      ["push", "--force-with-lease", "origin", `${wt.branchName}:${wt.branchName}`],
      scratchPath,
    );
    return { attempted: true, result: "success", rebasedBranch: wt.branchName };
  } catch (err) {
    deps.log.warn({ handoffId, err: String(err) }, "auto-rebase push failed; keeping local rebase");
    return {
      attempted: true,
      result: "success_local_only",
      rebasedBranch: wt.branchName,
    };
  }
}

async function attemptAutoRebase(ctx: ReconcileCtx): Promise<void> {
  const { deps, wt, handoffId, baseRef, state } = ctx;
  const snapshot = requireSnapshot(ctx);
  if (deps.reconcilerAutoRebase === false) {
    state.rebaseOutcome = { attempted: false, result: "skipped" };
    return;
  }
  const ffProbe = await execGitProbe(
    ctx,
    ["merge-base", "--is-ancestor", snapshot.baseTipSha, snapshot.branchHeadSha],
    deps.mainRepoDir,
  );
  if (ffProbe.exitCode === 0) {
    state.rebaseOutcome = { attempted: false, result: "skipped" };
    return;
  }
  if (ffProbe.exitCode !== 1) {
    deps.log.warn(
      {
        handoffId,
        baseRef,
        branch: wt.branchName,
        baseTipSha: snapshot.baseTipSha,
        branchHeadSha: snapshot.branchHeadSha,
        exitCode: ffProbe.exitCode,
        stderr: ffProbe.stderr.slice(0, 200),
      },
      "merge-base is-ancestor probe failed; skipping auto-rebase",
    );
    state.rebaseOutcome = { attempted: false, result: "skipped" };
    return;
  }

  state.rebaseOutcome = { attempted: true, result: "skipped" };
  const scratchRoot = deps.rebaseScratchRoot ?? join(homedir(), ".penumbra", "rebase-scratch");
  const scratchPath = join(scratchRoot, handoffId);
  await mkdir(scratchRoot, { recursive: true });

  await execGitSafe(ctx, ["worktree", "remove", "--force", scratchPath], deps.mainRepoDir);
  await rm(scratchPath, { recursive: true, force: true }).catch(noop);

  try {
    state.rebaseOutcome = await rebaseInScratch(ctx, scratchPath);
  } catch (err) {
    deps.log.warn({ handoffId, err: String(err) }, "auto-rebase failed unexpectedly");
  } finally {
    await execGitSafe(ctx, ["worktree", "remove", "--force", scratchPath], deps.mainRepoDir);
    await rm(scratchPath, { recursive: true, force: true }).catch(noop);
  }
}

function buildVerdictSummary(
  state: ReconcileState,
  result: MergeResult,
  ff_mergeable: boolean,
  pr_url: string | null,
): string {
  const summaryParts = [
    `typecheck:${state.typecheckStatus}`,
    `tests:${state.testStatus}`,
    `files:${String(state.diffStats.filesChanged)}`,
    `rebase:${state.rebaseOutcome.result}`,
    ff_mergeable ? "ff-ready" : "rebase-required",
  ];
  if (pr_url) summaryParts.push("pr-opened");
  if (result.status === "no_changes") summaryParts.push("no-changes");
  if (result.status === "typecheck_failed" || result.status === "test_failed") {
    const isEnvError = state.typecheckStatus === "error" || state.testStatus === "error";
    summaryParts.push(isEnvError ? "verification-error" : "verification-failed");
  }
  return summaryParts.join(" | ").slice(0, 220);
}

function hasHardFailingCheck(state: ReconcileState): boolean {
  return state.typecheckStatus === "fail" || state.testStatus === "fail";
}

function downgradeHardFailingChecksToError(state: ReconcileState): void {
  if (state.typecheckStatus === "fail") state.typecheckStatus = "error";
  if (state.testStatus === "fail") state.testStatus = "error";
}

async function recomputeVerdictDiffStats(ctx: ReconcileCtx): Promise<void> {
  const snapshot = requireSnapshot(ctx);
  const diffStatsRes = await execGitSafe(
    ctx,
    ["diff", snapshot.diffSpec, "--shortstat"],
    ctx.deps.mainRepoDir,
  );
  if (!diffStatsRes) return;
  ctx.state.diffStats = parseShortStat(diffStatsRes.stdout);
}

async function ensureVerdictDiffConsistency(ctx: ReconcileCtx): Promise<void> {
  const { deps, handoffId, wt, state } = ctx;
  if (!hasHardFailingCheck(state)) return;

  for (let attempt = 0; attempt < 2 && state.diffStats.filesChanged === 0; attempt += 1) {
    if (attempt > 0) {
      await refreshSnapshotFromDurableBranch(ctx);
    }
    await recomputeVerdictDiffStats(ctx);
  }

  const snapshot = requireSnapshot(ctx);
  if (snapshot.branchHeadSha === snapshot.baseTipSha || state.diffStats.filesChanged > 0) return;

  deps.log.warn(
    {
      handoffId,
      branch: wt.branchName,
      baseRef: ctx.baseRef,
      baseTipSha: snapshot.baseTipSha,
      branchHeadSha: snapshot.branchHeadSha,
    },
    "reconciler verdict diff is self-inconsistent; marking verification as unverified",
  );
  downgradeHardFailingChecksToError(state);
}

async function buildVerdict(ctx: ReconcileCtx, result: MergeResult): Promise<ReconcilerVerdict> {
  const { deps, wt, handoffId, handoff, state, startedAtMs } = ctx;
  await ensureVerdictDiffConsistency(ctx);
  const snapshot = requireSnapshot(ctx);
  const ffProbe = await execGitProbe(
    ctx,
    ["merge-base", "--is-ancestor", snapshot.baseTipSha, snapshot.branchHeadSha],
    deps.mainRepoDir,
  );

  const head_sha = snapshot.branchHeadSha;
  const base_sha = snapshot.baseTipSha;
  const ff_mergeable = ffProbe.exitCode === 0;
  const rebase_required = ffProbe.exitCode === 1;
  if (ffProbe.exitCode !== 0 && ffProbe.exitCode !== 1) {
    deps.log.warn(
      {
        handoffId,
        baseRef: ctx.baseRef,
        branch: wt.branchName,
        baseTipSha: snapshot.baseTipSha,
        branchHeadSha: snapshot.branchHeadSha,
        exitCode: ffProbe.exitCode,
        stderr: ffProbe.stderr.slice(0, 200),
      },
      "verdict merge-base probe errored; treating ancestry as unknown",
    );
  }
  const pr_url = result.pr_url ?? null;
  const duration_ms = Date.now() - startedAtMs;
  const summary = buildVerdictSummary(state, result, ff_mergeable, pr_url);

  const rebaseExtras: Pick<ReconcilerVerdict, "rebase_conflict_files" | "rebased_branch"> = {};
  if (state.rebaseOutcome.conflictFiles) {
    rebaseExtras.rebase_conflict_files = state.rebaseOutcome.conflictFiles;
  }
  if (state.rebaseOutcome.rebasedBranch) {
    rebaseExtras.rebased_branch = state.rebaseOutcome.rebasedBranch;
  }

  return {
    handoff_id: handoffId,
    conversation_id: handoff?.conversation_id ?? "unknown",
    branch: wt.branchName,
    head_sha: head_sha === "" ? "unknown" : head_sha,
    base_sha: base_sha === "" ? "unknown" : base_sha,
    typecheck: state.typecheckStatus,
    tests: state.testStatus,
    files_changed: state.diffStats.filesChanged,
    lines_added: state.diffStats.linesAdded,
    lines_deleted: state.diffStats.linesDeleted,
    ff_mergeable,
    rebase_required,
    rebase_attempted: state.rebaseOutcome.attempted,
    rebase_result: state.rebaseOutcome.result,
    ...rebaseExtras,
    pr_url,
    verified_at: new Date().toISOString(),
    duration_ms,
    summary,
    progressReported: result.progressReported,
  };
}

async function runThoughtAnalyzerIfEnabled(ctx: ReconcileCtx, result: MergeResult): Promise<void> {
  const { deps, handoffId } = ctx;
  const config = deps.thoughtsConfig;
  if (
    !config?.analyze.enabled ||
    !config.analyze.onlyWhen.includes(result.status) ||
    !deps.listThoughtEvents ||
    !deps.runThoughtAnalyzer ||
    !deps.thoughtAnalyzerDeps
  ) {
    return;
  }
  const parentHandoffId = deps.getParentHandoffId ? await deps.getParentHandoffId(handoffId) : null;
  if (parentHandoffId !== null) return;
  const thoughts = await deps.listThoughtEvents(handoffId);
  if (thoughts.length === 0) return;
  await deps.runThoughtAnalyzer({
    handoffId,
    thoughts,
    mergeStatus: result.status,
    config,
    deps: deps.thoughtAnalyzerDeps,
  });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve reconciliation result handling while grandfathering its pre-existing complexity.
async function emitResult(ctx: ReconcileCtx, result: MergeResult): Promise<void> {
  const { deps, handoffId } = ctx;
  let progressReported = true;
  try {
    await deps.postProgress(handoffId, {
      type: "merge-result",
      handoff_id: handoffId,
      ...result,
    });
  } catch (err) {
    progressReported = false;
    deps.log.warn(
      {
        handoffId,
        err: String(err),
        ...(err instanceof PenumbraHttpError
          ? { status: err.status, body: err.body, bodyText: err.bodyText }
          : {}),
      },
      "merge-result progress post failed",
    );
  }
  result.progressReported = progressReported;
  if (deps.captureResult) {
    try {
      await deps.captureResult(handoffId, result);
    } catch (err) {
      deps.log.warn({ handoffId, err: String(err) }, "agent performance capture failed");
    }
  }
  if (deps.emitVerdict) {
    try {
      await deps.emitVerdict(await buildVerdict(ctx, result));
    } catch (err) {
      deps.log.warn({ handoffId, err: String(err) }, "reconciler verdict emit failed");
    }
  }
  if (deps.notifyResult) {
    try {
      await deps.notifyResult(handoffId, result);
    } catch (err) {
      deps.log.warn({ handoffId, err: String(err) }, "merge-result notification failed");
    }
  }
  try {
    await runThoughtAnalyzerIfEnabled(ctx, result);
  } catch (err) {
    deps.log.warn({ handoffId, err: String(err) }, "thought analyzer failed");
  }
}

async function emitInvalidInputResult(
  ctx: ReconcileCtx,
  code: NonNullable<MergeResult["error_code"]>,
  details: Record<string, string>,
): Promise<MergeResult> {
  const { deps, handoffId } = ctx;
  const result: MergeResult = {
    status: "test_failed",
    error_code: code,
    regression_summary: JSON.stringify({ code, ...details }),
  };
  await deps.postProgress(handoffId, {
    type: "merge-result",
    handoff_id: handoffId,
    ...result,
  });
  if (deps.captureResult) {
    try {
      await deps.captureResult(handoffId, result);
    } catch (err) {
      deps.log.warn({ handoffId, err: String(err) }, "agent performance capture failed");
    }
  }
  if (deps.notifyResult) {
    try {
      await deps.notifyResult(handoffId, result);
    } catch (err) {
      deps.log.warn({ handoffId, err: String(err) }, "merge-result notification failed");
    }
  }
  return result;
}

async function gatherChangedFiles(ctx: ReconcileCtx): Promise<void> {
  const { deps, wt, state, handoffId } = ctx;
  const snapshot = requireSnapshot(ctx);
  const timeout = deps.settings?.reconcileTypecheckTimeoutSec ?? 120;
  try {
    // Use the symmetric-difference operator (`A...B`) consistently with the
    // no-changes gate and shortstat below so that scoping (which packages to
    // typecheck/test) and gating (does the branch differ?) measure the SAME
    // file set: changes B introduced since branching from A.
    const diffRes = await execGit(
      ctx,
      ["diff", "--name-only", snapshot.diffSpec],
      deps.mainRepoDir,
      timeout,
    );
    const diffFiles = diffRes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    state.changedFiles = new Set(diffFiles);
    const scope = scopeDiffToPackages(diffFiles, (dir) =>
      existsSync(join(wt.path, dir, "package.json")),
    );
    state.affectedPackages = scope.affectedPackages;
    state.deletedPackages = scope.deletedPackages;
    state.runRootTestShard = scope.runRootTestShard;
  } catch (err) {
    deps.log.warn(
      { handoffId, baseRef: ctx.baseRef, branch: wt.branchName, err: String(err) },
      "gatherChangedFiles diff failed; falling back to unscoped full-repo verification",
    );
    state.affectedPackages = null;
  }
}

async function runTypecheckOnAllPackages(
  ctx: ReconcileCtx,
  timeoutSeconds: number,
): Promise<MergeResult | null> {
  ctx.deps.log.debug({ handoffId: ctx.handoffId }, "running full typecheck in worktree");
  const res = await execCmd(ctx, ["bun", "tsc", "-b"], ctx.wt.path, timeoutSeconds);
  if (res.timedOut) {
    ctx.state.typecheckStatus = "fail";
    const result: MergeResult = {
      status: "typecheck_failed",
      timed_out: true,
      regression_summary: "typecheck timed out",
    };
    await emitResult(ctx, result);
    return result;
  }
  ctx.state.typecheckStatus = "pass";
  return null;
}

async function runScopedTypecheck(
  ctx: ReconcileCtx,
  affectedPackages: string[],
  timeoutSeconds: number,
): Promise<MergeResult | null> {
  for (const packageRoot of affectedPackages) {
    if (!isValidPackageRoot(packageRoot)) {
      return await emitInvalidInputResult(ctx, "invalid_test_package_path", {
        field: "package_root",
        value: packageRoot,
      });
    }
  }
  const affectedClosure = await computeAffectedPackageClosure(ctx);
  ctx.deps.log.debug(
    { handoffId: ctx.handoffId, affectedPackages },
    "running scoped typecheck in worktree",
  );
  const packagesToBuild = affectedClosure.packages.includes("packages/core")
    ? affectedClosure.packages
    : ["packages/core", ...affectedClosure.packages];
  ctx.state.packagesToBuild = packagesToBuild;
  const typecheckCommand = toCommandArgs("bun", ["tsc", "-b", ...packagesToBuild]);
  const res = await execCmd(ctx, typecheckCommand, ctx.wt.path, timeoutSeconds);
  if (res.timedOut) {
    ctx.state.typecheckStatus = "fail";
    const result: MergeResult = {
      status: "typecheck_failed",
      timed_out: true,
      regression_summary: `typecheck timed out for ${packagesToBuild.join(", ")}`,
    };
    await emitResult(ctx, result);
    return result;
  }
  ctx.state.typecheckStatus = "pass";
  return null;
}

async function handleTypecheckErrorWithDiagnostics(
  ctx: ReconcileCtx,
  diagnostics: TypecheckDiagnostic[],
): Promise<MergeResult | null> {
  const { state, deps, handoffId } = ctx;
  const affectedPackagePrefixes = (await computeAffectedPackageClosure(ctx)).prefixes;
  const directHits = diagnostics.filter((diag) => state.changedFiles.has(diag.file));
  const closureHits = diagnostics.filter(
    (diag) =>
      !state.changedFiles.has(diag.file) &&
      affectedPackagePrefixes.some((prefix) => diag.file.startsWith(prefix)),
  );
  const preExisting = diagnostics.filter(
    (diag) =>
      !state.changedFiles.has(diag.file) &&
      !affectedPackagePrefixes.some((prefix) => diag.file.startsWith(prefix)),
  );
  const attributed = [...directHits, ...closureHits];
  if (attributed.length === 0) {
    deps.log.warn(
      {
        component: "reconciler-typecheck-baseline-filter",
        handoff_id: handoffId,
        pre_existing_error_count: preExisting.length,
      },
      "pre-existing typecheck errors detected, not attributed to dispatched agent",
    );
    state.typecheckStatus = "pass";
    return null;
  }
  if (preExisting.length > 0) {
    deps.log.warn(
      {
        component: "reconciler-typecheck-baseline-filter",
        handoff_id: handoffId,
        pre_existing_error_count: preExisting.length,
        attributed_error_count: attributed.length,
      },
      "typecheck errors detected outside the dispatch closure",
    );
  }
  const result: MergeResult = {
    status: "typecheck_failed",
    regression_summary: formatTypecheckDiagnostics(attributed),
  };
  await emitResult(ctx, result);
  return result;
}

async function handleTypecheckErrorUnparsed(
  ctx: ReconcileCtx,
  err: CommandErrorInfo,
  rawText: string,
): Promise<MergeResult> {
  const { state, deps, handoffId } = ctx;
  deps.log.warn(
    {
      component: "reconciler-typecheck-parse-fallback",
      handoff_id: handoffId,
      raw_len: rawText.length,
    },
    "unable to parse typecheck diagnostics, falling back to raw output",
  );
  const affectedPackages = state.affectedPackages;
  const buildPackages =
    state.packagesToBuild ??
    (affectedPackages && affectedPackages.length > 0
      ? affectedPackages.includes("packages/core")
        ? affectedPackages
        : ["packages/core", ...affectedPackages]
      : []);
  const detail = err.stderr || err.stdout || rawText || "typecheck failed";
  const result: MergeResult = {
    status: "typecheck_failed",
    regression_summary:
      affectedPackages && affectedPackages.length > 0
        ? `${buildPackages.join(", ")}: ${detail}`
        : detail,
  };
  await emitResult(ctx, result);
  return result;
}

async function runTypecheckStage(ctx: ReconcileCtx): Promise<MergeResult | null> {
  const timeout = ctx.deps.settings?.reconcileTypecheckTimeoutSec ?? 120;
  const affectedPackages = ctx.state.affectedPackages;
  try {
    if (affectedPackages === null || ctx.state.deletedPackages.length > 0) {
      return await runTypecheckOnAllPackages(ctx, timeout);
    }
    if (affectedPackages.length === 0) {
      ctx.deps.log.debug({ handoffId: ctx.handoffId }, "skipping typecheck for docs-only diff");
      ctx.state.typecheckStatus = "skipped";
      return null;
    }
    return await runScopedTypecheck(ctx, affectedPackages, timeout);
  } catch (err: unknown) {
    const info = commandErrorInfo(err);
    if (isVerificationEnvironmentFailure(info)) {
      ctx.state.typecheckStatus = "error";
      ctx.deps.log.warn(
        { handoffId: ctx.handoffId, stage: "typecheck", err: String(err) },
        "verification environment failed; not attributable to dispatched code",
      );
      const result: MergeResult = {
        status: "typecheck_failed",
        regression_summary: `verification environment error (typecheck): ${String(err)}`,
        verification_environment_error: true,
      };
      await emitResult(ctx, result);
      return result;
    }
    ctx.state.typecheckStatus = "fail";
    const output = `${info.stdout}${info.stderr}`;
    const diagnostics = parseTypecheckDiagnostics(output);
    if (diagnostics.length > 0 && (ctx.state.changedFiles.size > 0 || affectedPackages === null)) {
      return await handleTypecheckErrorWithDiagnostics(ctx, diagnostics);
    }
    return await handleTypecheckErrorUnparsed(ctx, info, output);
  }
}

function didBunTestCommandPass(exitCode: number, report: BunTestReport): boolean {
  if (exitCode === 0) {
    return report.fails === null || (report.fails === 0 && report.errors === 0);
  }
  return isKnownBunTeardownPanicPass(report);
}

async function runParsedBunCommand(
  ctx: ReconcileCtx,
  argv: CommandArgs,
  cwd: string,
  timeout: number,
): Promise<BunTestCommandOutcome> {
  try {
    const res = await execCmd(ctx, argv, cwd, timeout);
    const stdout = res.stdout;
    const stderr = res.stderr;
    const report = parseBunTestReport(`${stdout}${stderr}`);
    return {
      timedOut: res.timedOut === true,
      envFailure: false,
      passed: res.timedOut === true ? false : didBunTestCommandPass(0, report),
      exitCode: 0,
      stdout,
      stderr,
      report,
    };
  } catch (err: unknown) {
    const info = commandErrorInfo(err);
    const report = parseBunTestReport(`${info.stdout}${info.stderr}`);
    return {
      timedOut: false,
      envFailure: isVerificationEnvironmentFailure(info),
      passed: didBunTestCommandPass(info.exitCode, report),
      exitCode: info.exitCode,
      stdout: info.stdout,
      stderr: info.stderr,
      report,
    };
  }
}

async function runBunTestCommand(
  ctx: ReconcileCtx,
  testArgs: string[],
  cwd: string,
  timeout: number,
): Promise<BunTestCommandOutcome> {
  return await runParsedBunCommand(ctx, toCommandArgs("bun", ["test", ...testArgs]), cwd, timeout);
}

// The repo's real gate shards root-level tests (test/, scripts/) through this
// exact invocation in .github/workflows/check.yml. The reconciler reuses it for
// root-shard diffs instead of an unscoped `bun test`, which cannot finish
// inside reconcileTestTimeoutSec. The gate streams the child's bun-test output
// verbatim, so the same pass/fail parser applies; a non-zero exit without a
// reachable summary fails closed exactly like an unparseable `bun test`.
const ROOT_TEST_SHARD_COMMAND: CommandArgs = [
  "bun",
  "scripts/bun-test-gate.ts",
  "--path-ignore-patterns=packages/**",
  "--path-ignore-patterns=**/console/e2e/**",
  "--path-ignore-patterns=**/visual/**",
  "--path-ignore-patterns=**/dist/**",
  "--path-ignore-patterns=**/scripts/bench*.test.ts",
];
// The merge-base baseline runs the shard's inner `bun test` argv directly —
// the gate only wraps it for panic tolerance, which didBunTestCommandPass
// already applies to parsed output.
const ROOT_TEST_SHARD_TEST_ARGS = ROOT_TEST_SHARD_COMMAND.slice(2);

function safePathToken(value: string): string {
  const token = value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return token.length > 0 ? token.slice(0, 120) : "unknown";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function mergeBaseLockfileHash(ctx: ReconcileCtx): Promise<string> {
  const snapshot = requireSnapshot(ctx);
  const lockfile = await execGitSafe(
    ctx,
    ["show", `${snapshot.mergeBaseSha}:bun.lock`],
    ctx.deps.mainRepoDir,
  );
  if (lockfile) return sha256Hex(lockfile.stdout);
  try {
    return sha256Hex(await readFile(join(ctx.deps.mainRepoDir, "bun.lock"), "utf8"));
  } catch {
    return "missing";
  }
}

async function testBaselineCacheKey(ctx: ReconcileCtx, testArgs: string[]): Promise<string> {
  const snapshot = requireSnapshot(ctx);
  const installKey =
    isolatedProvisioning().ISOLATED_INSTALL_CACHE_KEY ?? ISOLATED_INSTALL_CACHE_KEY;
  return [
    ctx.deps.mainRepoDir,
    snapshot.mergeBaseSha,
    await mergeBaseLockfileHash(ctx),
    installKey,
    ...testArgs,
  ].join("\0");
}

function isolatedProvisioning(): CoreIsolatedProvisioning {
  return core;
}

function coreInstallRunner(ctx: ReconcileCtx): WorktreeCommandRunner | undefined {
  const exec = ctx.deps.exec;
  if (!exec) return undefined;
  return async (cmd, args, opts) => {
    const execOpts: ReconcilerExecOptions = { cwd: opts?.cwd ?? process.cwd() };
    if (opts?.timeout !== undefined) execOpts.timeout = opts.timeout;
    if (opts?.maxBuffer !== undefined) execOpts.maxBuffer = opts.maxBuffer;
    if (opts?.encoding !== undefined) execOpts.encoding = opts.encoding;
    if (opts?.signal !== undefined) execOpts.signal = opts.signal;
    if (opts?.env !== undefined) execOpts.env = opts.env;
    if (opts?.stdio !== undefined) execOpts.stdio = opts.stdio;
    return await exec([cmd, ...args], execOpts);
  };
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function environmentFailureOutcome(err: unknown): BunTestCommandOutcome {
  const info = commandErrorInfo(err);
  const output = info.stderr || info.stdout || String(err);
  return {
    timedOut: false,
    envFailure: true,
    passed: false,
    exitCode: info.exitCode,
    stdout: info.stdout,
    stderr: output,
    report: parseBunTestReport(output),
  };
}

async function assertOwnedTestNodeModules(envRoot: string, label: string): Promise<void> {
  const rootRealpath = await realpath(envRoot);
  const nodeModulesPath = join(envRoot, "node_modules");
  const nodeModulesStat = await lstat(nodeModulesPath);
  if (nodeModulesStat.isSymbolicLink()) {
    throw new Error(
      `${label} test environment node_modules is a symlink: ${nodeModulesPath}. Recreate the worktree with isolated install before reconciling.`,
    );
  }
  if (!nodeModulesStat.isDirectory()) {
    throw new Error(
      `${label} test environment node_modules is not a directory: ${nodeModulesPath}. Recreate the worktree with isolated install before reconciling.`,
    );
  }

  const penumbraScopePath = join(nodeModulesPath, "@penumbra");
  const corePath = join(penumbraScopePath, "core");
  const coreRealpath = await realpath(corePath);
  if (!isPathInsideOrEqual(rootRealpath, coreRealpath)) {
    throw new Error(
      `${label} test environment @penumbra/core resolves outside env: ${coreRealpath}. Recreate the worktree with isolated install before reconciling.`,
    );
  }

  for (const entry of await readdir(penumbraScopePath)) {
    const packagePath = join(penumbraScopePath, entry);
    const packageRealpath = await realpath(packagePath);
    if (!isPathInsideOrEqual(rootRealpath, packageRealpath)) {
      throw new Error(
        `${label} test environment @penumbra/${entry} resolves outside env: ${packageRealpath}. Recreate the worktree with isolated install before reconciling.`,
      );
    }
  }
}

function provisionTestLocalCache(ctx: ReconcileCtx, envRoot: string): void {
  isolatedProvisioning().provisionLocalCache(ctx.deps.mainRepoDir, envRoot);
}

interface TestStageDeadline {
  expiresAtMs: number;
}

function remainingStageMs(deadline: TestStageDeadline): number {
  return Math.max(1, deadline.expiresAtMs - Date.now());
}

function remainingStageSeconds(deadline: TestStageDeadline): number {
  return remainingStageMs(deadline) / 1000;
}

async function runBunTestBaseline(
  ctx: ReconcileCtx,
  testArgs: string[],
  deadline: TestStageDeadline,
): Promise<BunTestCommandOutcome> {
  const { deps, handoffId } = ctx;
  const snapshot = requireSnapshot(ctx);
  const scratchRoot = deps.rebaseScratchRoot ?? join(homedir(), ".penumbra", "rebase-scratch");
  const scratchPath = join(scratchRoot, "test-baseline", safePathToken(handoffId));
  await mkdir(dirname(scratchPath), { recursive: true });
  await execGitSafe(ctx, ["worktree", "remove", "--force", scratchPath], deps.mainRepoDir);
  await rm(scratchPath, { recursive: true, force: true }).catch(noop);
  try {
    await execGit(
      ctx,
      ["worktree", "add", "--detach", scratchPath, snapshot.mergeBaseSha],
      deps.mainRepoDir,
    );
    const provisioning = isolatedProvisioning();
    provisioning.prepareEscapingFileDependencyLinks(deps.mainRepoDir, scratchPath);
    provisioning.provisionLocalCache(deps.mainRepoDir, scratchPath);
    await provisioning.runIsolatedInstall(scratchPath, {
      runner: coreInstallRunner(ctx),
      timeoutMs: remainingStageMs(deadline),
    });
    provisioning.materializeWorkspaceLinks(scratchPath);
    await assertOwnedTestNodeModules(scratchPath, "baseline");
    return await runBunTestCommand(ctx, testArgs, scratchPath, remainingStageSeconds(deadline));
  } catch (err) {
    return environmentFailureOutcome(err);
  } finally {
    await execGitSafe(ctx, ["worktree", "remove", "--force", scratchPath], deps.mainRepoDir);
    await rm(scratchPath, { recursive: true, force: true }).catch(noop);
  }
}

async function getCachedBunTestBaseline(
  ctx: ReconcileCtx,
  testArgs: string[],
  deadline: TestStageDeadline,
): Promise<BunTestCommandOutcome> {
  const key = await testBaselineCacheKey(ctx, testArgs);
  let pending = testBaselineCache.get(key);
  if (!pending) {
    pending = runBunTestBaseline(ctx, testArgs, deadline);
    testBaselineCache.set(key, pending);
  }
  try {
    const outcome = await pending;
    if (outcome.envFailure && testBaselineCache.get(key) === pending) {
      testBaselineCache.delete(key);
    }
    return outcome;
  } catch (err) {
    if (testBaselineCache.get(key) === pending) testBaselineCache.delete(key);
    throw err;
  }
}

function testOutcomeOutput(outcome: BunTestCommandOutcome): string {
  return outcome.stderr || outcome.stdout || outcome.report.rawOutput;
}

function formatNewTestFailures(newKeys: string[], outcome: BunTestCommandOutcome): string {
  if (newKeys.length === 0) {
    return testOutcomeOutput(outcome) || "tests failed";
  }
  const visible = newKeys.slice(0, 20).map((key) => key.replace(/^fail:|^error:/, ""));
  if (newKeys.length > 20) visible.push(`... (${String(newKeys.length - 20)} more)`);
  const detail = testOutcomeOutput(outcome);
  return `new test failures:\n${visible.join("\n")}${detail ? `\n\n${detail}` : ""}`;
}

function findNewFailureKeys(
  branch: BunTestCommandOutcome,
  baseline: BunTestCommandOutcome,
): string[] {
  const baselineKeys = new Set(baseline.report.failureKeys);
  return branch.report.failureKeys.filter((key) => !baselineKeys.has(key));
}

function canCompareAgainstBaseline(outcome: BunTestCommandOutcome): boolean {
  return (
    outcome.report.reachedSummary && !outcome.passed && !outcome.timedOut && !outcome.envFailure
  );
}

function summaryTestCount(output: string): number | null {
  const matches = [...output.matchAll(/Ran\s+(\d+)\s+tests?\b/g)];
  const last = matches.at(-1);
  return last?.[1] ? Number.parseInt(last[1], 10) : null;
}

function isCredibleBunTestBaseline(outcome: BunTestCommandOutcome): boolean {
  const { report } = outcome;
  if (report.pass === null) return false;
  const ran = summaryTestCount(report.output);
  if (ran === null) return false;
  const accountedTests = report.pass + (report.fails ?? 0);
  if (report.pass > ran || accountedTests > ran) return false;
  // A zero-pass baseline whose reported failures are only load errors cannot
  // establish whether branch failures are regressions or missing dependencies.
  return !(
    report.pass === 0 &&
    report.failureKeys.length > 0 &&
    report.failureKeys.every((key) => key.startsWith("error:"))
  );
}

async function emitTestFailure(
  ctx: ReconcileCtx,
  regressionSummary: string,
  timedOut = false,
): Promise<MergeResult> {
  ctx.state.testStatus = "fail";
  const result: MergeResult = {
    status: "test_failed",
    regression_summary: regressionSummary,
    ...(timedOut ? { timed_out: true } : {}),
  };
  await emitResult(ctx, result);
  return result;
}

async function emitTestEnvironmentError(
  ctx: ReconcileCtx,
  regressionSummary: string,
): Promise<MergeResult> {
  ctx.state.testStatus = "error";
  ctx.deps.log.warn(
    { handoffId: ctx.handoffId, stage: "tests", err: regressionSummary },
    "verification environment failed; not attributable to dispatched code",
  );
  const result: MergeResult = {
    status: "test_failed",
    regression_summary: `verification environment error (tests): ${regressionSummary}`,
    verification_environment_error: true,
  };
  await emitResult(ctx, result);
  return result;
}

async function evaluateBunTestOutcome(
  ctx: ReconcileCtx,
  testArgs: string[],
  deadline: TestStageDeadline,
  outcome: BunTestCommandOutcome,
): Promise<MergeResult | null> {
  if (outcome.timedOut) {
    return await emitTestFailure(ctx, "tests timed out", true);
  }
  if (outcome.envFailure) {
    return await emitTestEnvironmentError(ctx, "empty stdout/stderr from test command");
  }
  if (outcome.passed) {
    ctx.state.testStatus = "pass";
    return null;
  }
  if (!canCompareAgainstBaseline(outcome)) {
    return await emitTestFailure(ctx, testOutcomeOutput(outcome) || "tests failed");
  }

  const baseline = await getCachedBunTestBaseline(ctx, testArgs, deadline);
  if (baseline.timedOut) {
    return await emitTestEnvironmentError(ctx, "baseline tests timed out");
  }
  if (baseline.envFailure) {
    return await emitTestEnvironmentError(
      ctx,
      testOutcomeOutput(baseline) || "empty stdout/stderr from baseline test command",
    );
  }
  if (!baseline.report.reachedSummary) {
    return await emitTestEnvironmentError(
      ctx,
      testOutcomeOutput(baseline) || "baseline tests did not reach a summary",
    );
  }
  if (!isCredibleBunTestBaseline(baseline)) {
    return await emitTestEnvironmentError(
      ctx,
      "baseline ran no successful tests and reported only load errors",
    );
  }
  const newFailureKeys = findNewFailureKeys(outcome, baseline);
  if (newFailureKeys.length === 0) {
    ctx.deps.log.warn(
      { handoffId: ctx.handoffId, testArgs },
      "scoped tests failed only with failures already present at branch base",
    );
    ctx.state.testStatus = "pass";
    return null;
  }
  return await emitTestFailure(ctx, formatNewTestFailures(newFailureKeys, outcome));
}

async function runTestsStage(ctx: ReconcileCtx): Promise<MergeResult | null> {
  const { deps, wt, handoffId, state } = ctx;
  try {
    deps.log.debug({ handoffId }, "scoping tests from git diff");
    const timeout = deps.settings?.reconcileTestTimeoutSec ?? 300;
    const deadline = { expiresAtMs: Date.now() + timeout * 1000 };
    const affectedPackages = state.affectedPackages;

    if (affectedPackages === null) {
      deps.log.debug({ handoffId }, "running full test suite in worktree");
      state.testCommandUsed = "bun test";
      provisionTestLocalCache(ctx, wt.path);
      try {
        await assertOwnedTestNodeModules(wt.path, "branch");
      } catch (err) {
        return await emitTestEnvironmentError(ctx, String(err));
      }
      // Deliberate check-then-run TOCTOU: filesystem tampering after this point
      // is outside the reconciler's threat model.
      return await evaluateBunTestOutcome(
        ctx,
        [],
        deadline,
        await runBunTestCommand(ctx, [], wt.path, remainingStageSeconds(deadline)),
      );
    }
    if (affectedPackages.length === 0 && !state.runRootTestShard) {
      deps.log.debug({ handoffId }, "skipping tests for docs-only diff");
      state.testCommandUsed = "skipped (docs-only diff)";
      state.testStatus = "skipped";
      return null;
    }
    const scopedTestPaths = affectedPackages.map((pkg) => `${pkg}/test/`);
    for (const testPath of scopedTestPaths) {
      if (!isValidTestPackagePath(testPath)) {
        return await emitInvalidInputResult(ctx, "invalid_test_package_path", {
          field: "test_path",
          value: testPath,
        });
      }
    }
    deps.log.debug(
      { handoffId, affectedPackages, rootTestShard: state.runRootTestShard },
      "running scoped tests in worktree",
    );
    provisionTestLocalCache(ctx, wt.path);
    try {
      await assertOwnedTestNodeModules(wt.path, "branch");
    } catch (err) {
      return await emitTestEnvironmentError(ctx, String(err));
    }
    // Deliberate check-then-run TOCTOU: filesystem tampering after this point
    // is outside the reconciler's threat model.
    return await runDiffScopedShards(ctx, scopedTestPaths, deadline);
  } catch (err: unknown) {
    const info = commandErrorInfo(err);
    if (isVerificationEnvironmentFailure(info)) {
      state.testStatus = "error";
      deps.log.warn(
        { handoffId, stage: "tests", err: String(err) },
        "verification environment failed; not attributable to dispatched code",
      );
      const result: MergeResult = {
        status: "test_failed",
        regression_summary: `verification environment error (tests): ${String(err)}`,
        verification_environment_error: true,
      };
      await emitResult(ctx, result);
      return result;
    }
    state.testStatus = "fail";
    const result: MergeResult = {
      status: "test_failed",
      regression_summary: info.stderr || info.stdout || String(err),
    };
    await emitResult(ctx, result);
    return result;
  }
}

async function runDiffScopedShards(
  ctx: ReconcileCtx,
  scopedTestPaths: string[],
  deadline: TestStageDeadline,
): Promise<MergeResult | null> {
  const commandsUsed: string[] = [];
  if (scopedTestPaths.length > 0) {
    commandsUsed.push(`bun test ${scopedTestPaths.join(" ")}`);
    ctx.state.testCommandUsed = commandsUsed.join(" && ");
    const scopedResult = await evaluateBunTestOutcome(
      ctx,
      scopedTestPaths,
      deadline,
      await runBunTestCommand(ctx, scopedTestPaths, ctx.wt.path, remainingStageSeconds(deadline)),
    );
    if (scopedResult) return scopedResult;
  }
  if (ctx.state.runRootTestShard) {
    commandsUsed.push(ROOT_TEST_SHARD_COMMAND.join(" "));
    ctx.state.testCommandUsed = commandsUsed.join(" && ");
    return await evaluateBunTestOutcome(
      ctx,
      [...ROOT_TEST_SHARD_TEST_ARGS],
      deadline,
      await runParsedBunCommand(
        ctx,
        ROOT_TEST_SHARD_COMMAND,
        ctx.wt.path,
        remainingStageSeconds(deadline),
      ),
    );
  }
  return null;
}

async function runPrCreationStage(ctx: ReconcileCtx): Promise<MergeResult> {
  const { deps, wt, baseRef, handoffId, handoff, state } = ctx;
  const snapshot = requireSnapshot(ctx);
  deps.log.debug({ handoffId }, "acquired global merge lock");
  try {
    const dispatchPrompt = handoff?.message ?? "<unknown>";
    const agentName = handoff?.to_agent ?? "<unknown>";
    const conversationId = handoff?.conversation_id ?? null;
    const diffNames = await execGit(
      ctx,
      ["diff", "--name-only", snapshot.diffSpec],
      deps.mainRepoDir,
    );
    if (!diffNames.stdout.trim()) {
      const result: MergeResult = { status: "no_changes" };
      deps.log.info(
        { handoffId, branch: wt.branchName },
        "reconciliation complete — no branch changes",
      );
      await emitResult(ctx, result);
      return result;
    }
    const diffStatsRes = await execGit(ctx, ["diff", snapshot.diffSpec, "--shortstat"], wt.path);
    state.diffStats = parseShortStat(diffStatsRes.stdout);
    await attemptAutoRebase(ctx);
    const shouldOpenPr = handoff?.open_pr_on_review === true;
    if (!shouldOpenPr) {
      const result: MergeResult = { status: "verified" };
      deps.log.info(
        { handoffId, branch: wt.branchName },
        "reconciliation complete — verified without PR",
      );
      await emitResult(ctx, result);
      return result;
    }
    const createPR = deps.createDispatchPR ?? createDispatchPR;
    const titleLine = dispatchPrompt.split("\n")[0] ?? "";
    const prResult = await createPR(
      {
        branch: wt.branchName,
        baseBranch: baseRef,
        title: `[${agentName}] ${titleLine.slice(0, 60)}`,
        body: renderDispatchPRBody({
          agentName,
          handoffId,
          conversationId,
          prompt: dispatchPrompt,
          typecheckStatus: "pass",
          testCommand: state.testCommandUsed,
          testSummary: "pass",
          diffStats: diffStatsRes.stdout,
        }),
        draft: false,
        cwd: wt.path,
      },
      deps.log,
    );

    const result: MergeResult = {
      status: "pr_opened",
      pr_url: prResult.url,
      pr_number: prResult.number,
    };
    deps.log.info(
      { handoffId, prUrl: prResult.url, prNumber: prResult.number },
      "reconciliation complete — PR opened",
    );
    await emitResult(ctx, result);
    return result;
  } catch (err: unknown) {
    deps.log.error({ handoffId, err: String(err) }, "PR creation failed");
    const result: MergeResult = {
      status: "pr_creation_failed",
      regression_summary: String(err),
    };
    await emitResult(ctx, result);
    return result;
  }
}

export function createMergeReconciler(
  deps: ReconcilerDeps,
): (handoffId: string) => Promise<MergeResult> {
  return async function reconcileWorktree(handoffId: string): Promise<MergeResult> {
    const wt = deps.worktreeManager.getWorktree(handoffId);
    if (!wt) {
      deps.log.debug({ handoffId }, "no worktree found for reconciliation, skipping");
      return { status: "merged" };
    }

    deps.log.info({ handoffId, path: wt.path }, "starting worktree reconciliation");
    const startedAtMs = Date.now();
    const handoff = await deps.getHandoff(handoffId);
    // Compute baseRef up front so the rebase/verdict/no-changes/diffStats stages
    // all share the same value. Validation happens after the ctx is in scope.
    const baseRef =
      handoff?.branch_base && handoff.branch_base !== "main" ? handoff.branch_base : "main";

    const ctx: ReconcileCtx = {
      deps,
      handoffId,
      handoff,
      wt,
      baseRef,
      startedAtMs,
      snapshot: null,
      packageJsonCache: new Map<string, WorkspacePackageJson | null>(),
      state: {
        typecheckStatus: "skipped",
        testStatus: "skipped",
        diffStats: { filesChanged: 0, linesAdded: 0, linesDeleted: 0 },
        rebaseOutcome: { attempted: false, result: "skipped" },
        affectedPackages: null,
        deletedPackages: [],
        packagesToBuild: null,
        changedFiles: new Set<string>(),
        runRootTestShard: false,
        testCommandUsed: "bun test",
      },
    };

    if (!isValidGitRef(wt.branchName)) {
      return await emitInvalidInputResult(ctx, "invalid_branch", {
        field: "branch",
        value: wt.branchName,
      });
    }
    if (!isValidGitRef(baseRef)) {
      return await emitInvalidInputResult(ctx, "invalid_branch_base", {
        field: "branch_base",
        value: baseRef,
      });
    }

    await resolveReconcileSnapshot(ctx);
    await gatherChangedFiles(ctx);

    const typecheckResult = await runTypecheckStage(ctx);
    if (typecheckResult) return typecheckResult;

    const testResult = await runTestsStage(ctx);
    if (testResult) return testResult;

    return await globalMergeLock.withLock(async () => {
      return await runPrCreationStage(ctx);
    });
  };
}
