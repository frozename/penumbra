import type { Services, WorktreeHandle } from "@penumbra/core";

import { execFile as execFileCb } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const INSPECTION_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
const DIFF_MAX_BYTES = 10 * 1024;
const LOG_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n... [truncated]";

const WORKTREE_STATUS_PATHS = [
  ".",
  ":(exclude)node_modules",
  ":(exclude)packages/*/node_modules",
  ":(exclude).test-storage",
] as const;

export type WorktreeInspection = {
  worktree: WorktreeHandle;
  diff_against_main: string;
  branch_log: string;
  head_sha: string;
  branch_name: string;
  base_ref: string;
  base_fallback: boolean;
  base_attempted_ref: string;
  base_fallback_reason: "unresolvable" | "rejected_ref" | "chain_limit" | null;
  dirty: boolean;
  truncation: {
    diff_against_main: boolean;
    branch_log: boolean;
    total: boolean;
  };
};

/**
 * Cheap fields from the first snapshot, returned with an `inspection_failed`
 * deadline error that hit after that snapshot passed its identity checks.
 * `verified` is always false: the post-diff recheck did not complete, so the
 * worktree may have moved since these values were read.
 * The four base fields are present together and only once the base resolved;
 * a deadline during base resolution returns none of them.
 */
export type WorktreeInspectionPartial = {
  head_sha: string;
  branch_name: string;
  dirty: boolean;
  base_ref?: string;
  base_fallback?: boolean;
  base_attempted_ref?: string;
  base_fallback_reason?: "unresolvable" | "rejected_ref" | "chain_limit" | null;
  verified: false;
};

export type WorktreeInspectionResult =
  | { ok: true; inspection: WorktreeInspection }
  | {
      ok: false;
      code: "not_found" | "inspection_failed";
      message: string;
      partial?: WorktreeInspectionPartial;
    };

export type WorktreeInspectionCommandRunner = (
  args: readonly string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export type WorktreeInspectionOptions = {
  expectedProjectId?: string;
  deadline?: () => { remaining_ms: number | null; expired: boolean };
  runGit?: WorktreeInspectionCommandRunner;
};

const defaultRunGit: WorktreeInspectionCommandRunner = async (args, opts) => {
  return await execFile("git", [...args], { ...opts, encoding: "utf8" });
};

class InspectionDeadlineError extends Error {
  readonly step: string | undefined;

  constructor(step?: string) {
    super("worktree inspection deadline expired");
    this.step = step;
  }
}

type InspectionPhase = "snapshot" | "base" | "diff" | "log" | "recheck";

function deadlineMessage(step: string, elapsedMs: number, budgetMs: number): string {
  return `worktree inspection deadline expired during ${step} after ${String(elapsedMs)} ms (budget ${String(budgetMs)} ms)`;
}

function inspectionErrorMessage(
  err: unknown,
  lastStep: string | undefined,
  phase: InspectionPhase,
  elapsedMs: number,
  budgetMs: number,
): string {
  if (err instanceof InspectionDeadlineError) {
    return deadlineMessage(err.step ?? lastStep ?? phase, elapsedMs, budgetMs);
  }
  return errorMessage(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inspectionFailure(message: string): WorktreeInspectionResult {
  return { ok: false, code: "inspection_failed", message };
}

function projectMatchesExpected(actual: string | null, expected: string | undefined): boolean {
  return expected === undefined || actual === expected;
}

const INSPECTION_BASE_REF_RE = /^[\w.][\w./+@-]{0,199}$/;
const MAX_BASE_CHAIN = 16;

type InspectionGit = {
  run: (args: readonly string[]) => Promise<string>;
  budgetSpent: () => boolean;
};

type InspectionFallbackReason = "unresolvable" | "rejected_ref" | "chain_limit";

type ResolvedInspectionBase = {
  baseRef: string;
  baseSha: string;
  attemptedRef: string;
  fallbackReason: InspectionFallbackReason | null;
};

// fix-until-green rounds and stacked plan tasks set branch_base to the previous
// handoff's branch, which dispatch_land may later delete. Follow the chain to the
// root dispatch base so inspection always sees the full task delta. Only follow an
// owner in the same project (findByBranchName is unscoped, so a stray row from
// another project must not redirect the diff); a cycle or chain-limit exhaustion is
// reported as exhausted so the caller falls back to main rather than a still-owned ref.
// MAX_BASE_CHAIN bounds owned links, so the unowned root a full-length chain points at
// still resolves.
function rootInspectionBase(
  services: Services,
  branchBase: string | null | undefined,
  projectId: string | null,
): { ref: string; exhausted: boolean } {
  let ref = branchBase ?? "main";
  const seen = new Set<string>();
  while (!seen.has(ref)) {
    seen.add(ref);
    const owner = services.handoffReader.findByBranchName(ref);
    if (owner?.project_id !== projectId) return { ref, exhausted: false };
    if (seen.size > MAX_BASE_CHAIN) return { ref, exhausted: true };
    ref = owner.branch_base ?? "main";
  }
  return { ref, exhausted: true };
}

function isInspectableRef(ref: string): boolean {
  return INSPECTION_BASE_REF_RE.test(ref) && !ref.includes("..") && ref !== "HEAD" && ref !== "@";
}

// execFile marks a child it killed itself with killed: true; that is the command
// timeout here, except for the maxBuffer overflow kill, which carries its own code.
function killedByTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "killed" in err &&
    err.killed === true &&
    !("code" in err && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
  );
}

async function runInspectionGit(
  runGit: WorktreeInspectionCommandRunner,
  canonicalPath: string,
  args: readonly string[],
  step: string,
  remainingMs: () => number,
): Promise<string> {
  const timeout = remainingMs();
  if (timeout <= 0) throw new InspectionDeadlineError(step);
  try {
    const result = await runGit(["-c", "core.fsmonitor=false", "-C", canonicalPath, ...args], {
      timeout,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    return result.stdout;
  } catch (err) {
    if (killedByTimeout(err)) throw new InspectionDeadlineError(step);
    throw err;
  }
}

async function tryRevParse(git: InspectionGit, ref: string): Promise<string | undefined> {
  try {
    return (await git.run(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  } catch (err) {
    // A spent budget is not a missing ref; swallowing it would report the deadline
    // as "no inspection base resolves". The budget can also run out while rev-parse
    // is running, in which case the timeout kills the child and execFile rejects
    // with a plain error rather than InspectionDeadlineError.
    if (err instanceof InspectionDeadlineError) throw err;
    if (git.budgetSpent() || killedByTimeout(err)) throw new InspectionDeadlineError();
    return undefined;
  }
}

async function resolveMainSha(git: InspectionGit, triedRefs: readonly string[]): Promise<string> {
  const mainSha = await tryRevParse(git, "main");
  if (mainSha === undefined) {
    throw new Error(`no inspection base resolves (tried ${[...triedRefs, "main"].join(", ")})`);
  }
  return mainSha;
}

async function fallbackToMain(
  git: InspectionGit,
  attemptedRef: string,
  reason: InspectionFallbackReason,
  triedRefs: readonly string[],
): Promise<ResolvedInspectionBase> {
  const baseSha = await resolveMainSha(git, triedRefs);
  return { baseRef: "main", baseSha, attemptedRef, fallbackReason: reason };
}

async function resolveInspectionBase(
  git: InspectionGit,
  root: { ref: string; exhausted: boolean },
): Promise<ResolvedInspectionBase> {
  const attemptedRef = root.ref;
  if (root.exhausted) {
    return await fallbackToMain(git, attemptedRef, "chain_limit", []);
  }
  if (root.ref === "main") {
    const baseSha = await resolveMainSha(git, []);
    return { baseRef: "main", baseSha, attemptedRef, fallbackReason: null };
  }
  if (!isInspectableRef(root.ref)) {
    return await fallbackToMain(git, attemptedRef, "rejected_ref", []);
  }
  const sha = await tryRevParse(git, root.ref);
  if (sha !== undefined) {
    return { baseRef: root.ref, baseSha: sha, attemptedRef, fallbackReason: null };
  }
  return await fallbackToMain(git, attemptedRef, "unresolvable", [root.ref]);
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const input = Buffer.from(value);
  if (input.byteLength <= maxBytes) return { value, truncated: false };
  const marker = Buffer.from(TRUNCATION_MARKER);
  let end = maxBytes - marker.byteLength;
  while (end > 0 && (input[end] ?? 0) >> 6 === 0b10) end -= 1;
  return {
    value: `${input.subarray(0, end).toString("utf8")}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

type GitSnapshot = {
  canonicalTopLevel: string;
  headSha: string;
  branchName: string;
  branchReflog: string;
  status: string;
};

function sameHandle(left: WorktreeHandle, right: WorktreeHandle): boolean {
  return (
    left.handoffId === right.handoffId &&
    left.path === right.path &&
    left.branchName === right.branchName &&
    left.projectId === right.projectId
  );
}

function hasUsableBranchReflogIdentity(
  branchReflog: string,
  headSha: string,
  branchName: string,
): boolean {
  const headSeparator = branchReflog.indexOf(":");
  const selectorSeparator = branchReflog.indexOf(":", headSeparator + 1);
  if (headSeparator <= 0 || selectorSeparator <= headSeparator + 1) return false;
  const reflogHead = branchReflog.slice(0, headSeparator);
  const reflogSelector = branchReflog.slice(headSeparator + 1, selectorSeparator);
  const reflogEntry = branchReflog.slice(selectorSeparator + 1);
  return (
    reflogHead === headSha &&
    reflogEntry.length > 0 &&
    (reflogSelector === `${branchName}@{0}` || reflogSelector === `refs/heads/${branchName}@{0}`)
  );
}

function initialSnapshotFailure(
  snapshot: GitSnapshot,
  canonicalPath: string,
  worktree: WorktreeHandle,
): string | null {
  if (snapshot.canonicalTopLevel !== canonicalPath) {
    return "worktree path is not the canonical Git top-level";
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot.headSha)) {
    return "worktree HEAD is not a full Git object id";
  }
  if (snapshot.branchName !== worktree.branchName) {
    return "worktree symbolic branch does not match the handoff branch";
  }
  if (
    !hasUsableBranchReflogIdentity(snapshot.branchReflog, snapshot.headSha, snapshot.branchName)
  ) {
    return "worktree branch reflog identity is unavailable";
  }
  return null;
}

function snapshotChanged(
  before: GitSnapshot,
  after: GitSnapshot,
  canonicalPath: string,
  finalCanonicalPath: string,
): boolean {
  return (
    finalCanonicalPath !== canonicalPath ||
    after.canonicalTopLevel !== canonicalPath ||
    after.headSha !== before.headSha ||
    after.branchName !== before.branchName ||
    after.branchReflog !== before.branchReflog ||
    after.status !== before.status
  );
}

// #263: a deadline after the first snapshot passed its checks still returns the
// cheap fields from that snapshot, plus the base fields once the base resolved;
// any other error stays message-only.
function caughtInspectionFailure(
  err: unknown,
  message: string,
  before: GitSnapshot | undefined,
  base: ResolvedInspectionBase | undefined,
): WorktreeInspectionResult {
  if (!(err instanceof InspectionDeadlineError) || before === undefined) {
    return inspectionFailure(message);
  }
  const partial: WorktreeInspectionPartial = {
    head_sha: before.headSha,
    branch_name: before.branchName,
    dirty: before.status.trim().length > 0,
    ...(base === undefined
      ? {}
      : {
          base_ref: base.baseRef,
          base_fallback: base.fallbackReason !== null,
          base_attempted_ref: base.attemptedRef,
          base_fallback_reason: base.fallbackReason,
        }),
    verified: false,
  };
  return { ok: false, code: "inspection_failed", message, partial };
}

export async function inspectWorktreeForHandoff(
  services: Services,
  handoffId: string,
  options: WorktreeInspectionOptions = {},
): Promise<WorktreeInspectionResult> {
  const handoff = services.handoffReader.get(handoffId);
  if (!handoff || !projectMatchesExpected(handoff.project_id, options.expectedProjectId)) {
    return { ok: false, code: "not_found", message: `worktree for handoff ${handoffId} not found` };
  }
  const initialDeadline = options.deadline?.();
  if (initialDeadline?.expired) {
    return inspectionFailure("worktree inspection deadline expired before inspection started");
  }
  const worktree = services.worktreeManager.getWorktree(handoffId, handoff.project_id ?? undefined);
  if (!worktree) {
    return { ok: false, code: "not_found", message: `worktree for handoff ${handoffId} not found` };
  }

  const refreshedHandoff = services.handoffReader.get(handoffId);
  const handoffProjectId = refreshedHandoff?.project_id ?? undefined;
  if (
    refreshedHandoff?.project_id !== handoff.project_id ||
    worktree.handoffId !== handoffId ||
    worktree.projectId !== handoffProjectId ||
    refreshedHandoff.branch_name === null ||
    refreshedHandoff.branch_name === undefined ||
    worktree.branchName !== refreshedHandoff.branch_name
  ) {
    return inspectionFailure("worktree handle does not match the persisted handoff");
  }

  const runGit = options.runGit ?? defaultRunGit;
  const startedAt = Date.now();
  const initialRemaining = initialDeadline?.remaining_ms;
  const inspectionBudgetMs =
    initialRemaining === null || initialRemaining === undefined
      ? INSPECTION_TIMEOUT_MS
      : Math.min(INSPECTION_TIMEOUT_MS, initialRemaining);
  let canonicalPath: string;
  let phase: InspectionPhase = "snapshot";
  let lastStep: string | undefined;
  let verifiedBefore: GitSnapshot | undefined;
  let resolvedBase: ResolvedInspectionBase | undefined;

  const remainingMs = (): number => {
    const localRemaining = inspectionBudgetMs - (Date.now() - startedAt);
    const externalDeadline = options.deadline?.();
    if (externalDeadline?.expired) return 0;
    const externalRemaining = externalDeadline?.remaining_ms;
    return Math.floor(
      externalRemaining === null || externalRemaining === undefined
        ? localRemaining
        : Math.min(localRemaining, externalRemaining),
    );
  };

  const git = async (args: readonly string[]): Promise<string> => {
    const step = `${phase} (git ${args[0] ?? "?"})`;
    lastStep = step;
    return await runInspectionGit(runGit, canonicalPath, args, step, remainingMs);
  };

  const captureGitOutput = async (
    args: readonly string[],
  ): Promise<{ value: string; truncated: boolean }> => {
    try {
      return { value: await git(args), truncated: false };
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
        "stdout" in err &&
        typeof err.stdout === "string"
      ) {
        return { value: err.stdout, truncated: true };
      }
      throw err;
    }
  };

  const readSnapshot = async (): Promise<GitSnapshot> => {
    const topLevel = (await git(["rev-parse", "--show-toplevel"])).trim();
    const canonicalTopLevel = await realpath(topLevel);
    const headSha = (await git(["rev-parse", "HEAD"])).trim();
    const branchName = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    const branchReflog = (
      await git(["reflog", "show", "-1", "--format=%H:%gD:%gs", branchName])
    ).trim();
    const status = await git([
      "status",
      "--short",
      "--untracked-files=all",
      "--",
      ...WORKTREE_STATUS_PATHS,
    ]);
    return { canonicalTopLevel, headSha, branchName, branchReflog, status };
  };

  try {
    canonicalPath = await realpath(worktree.path);
    const before = await readSnapshot();
    const initialFailure = initialSnapshotFailure(before, canonicalPath, worktree);
    if (initialFailure) return inspectionFailure(initialFailure);
    verifiedBefore = before;

    phase = "base";
    const { baseRef, baseSha, attemptedRef, fallbackReason } = await resolveInspectionBase(
      { run: git, budgetSpent: () => remainingMs() <= 0 },
      rootInspectionBase(
        services,
        refreshedHandoff.branch_base,
        refreshedHandoff.project_id ?? null,
      ),
    );
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha)) {
      return inspectionFailure(`${baseRef} is not a full Git object id`);
    }
    resolvedBase = { baseRef, baseSha, attemptedRef, fallbackReason };
    const comparisonRange = `${baseSha}..${before.headSha}`;
    phase = "diff";
    const diff = await captureGitOutput([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      `${baseSha}...${before.headSha}`,
    ]);
    phase = "log";
    const log = await captureGitOutput(["log", "--oneline", comparisonRange]);
    phase = "recheck";
    const after = await readSnapshot();
    const finalCanonicalPath = await realpath(worktree.path);
    if (snapshotChanged(before, after, canonicalPath, finalCanonicalPath)) {
      return inspectionFailure("worktree changed during inspection");
    }

    const finalHandoff = services.handoffReader.get(handoffId);
    const finalHandle = services.worktreeManager.getWorktree(handoffId, handoffProjectId);
    if (
      finalHandoff?.project_id !== refreshedHandoff.project_id ||
      finalHandoff.branch_name !== refreshedHandoff.branch_name ||
      !finalHandle ||
      !sameHandle(worktree, finalHandle)
    ) {
      return inspectionFailure("worktree binding changed during inspection");
    }

    const parts = [diff.value];
    if (before.status.trim()) parts.push(`\n# git status --short\n${before.status}`);
    const boundedDiff = truncateUtf8(parts.join(""), DIFF_MAX_BYTES);
    const boundedLog = truncateUtf8(log.value, LOG_MAX_BYTES);
    const diffTruncated = diff.truncated || boundedDiff.truncated;
    const logTruncated = log.truncated || boundedLog.truncated;
    return {
      ok: true,
      inspection: {
        worktree,
        diff_against_main: boundedDiff.value,
        branch_log: boundedLog.value,
        head_sha: before.headSha,
        branch_name: before.branchName,
        base_ref: baseRef,
        base_fallback: fallbackReason !== null,
        base_attempted_ref: attemptedRef,
        base_fallback_reason: fallbackReason,
        dirty: before.status.trim().length > 0,
        truncation: {
          diff_against_main: diffTruncated,
          branch_log: logTruncated,
          total: diffTruncated || logTruncated,
        },
      },
    };
  } catch (err) {
    return caughtInspectionFailure(
      err,
      inspectionErrorMessage(err, lastStep, phase, Date.now() - startedAt, inspectionBudgetMs),
      verifiedBefore,
      resolvedBase,
    );
  }
}
