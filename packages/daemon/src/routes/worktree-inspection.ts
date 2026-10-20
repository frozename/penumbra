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

export type WorktreeInspectionResult =
  | { ok: true; inspection: WorktreeInspection }
  | { ok: false; code: "not_found" | "inspection_failed"; message: string };

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
function rootInspectionBase(
  services: Services,
  branchBase: string | null | undefined,
  projectId: string | null,
): { ref: string; exhausted: boolean } {
  let ref = branchBase ?? "main";
  const seen = new Set<string>();
  while (!seen.has(ref)) {
    if (seen.size >= MAX_BASE_CHAIN) return { ref, exhausted: true };
    seen.add(ref);
    const owner = services.handoffReader.findByBranchName(ref);
    if (owner?.project_id !== projectId) return { ref, exhausted: false };
    ref = owner.branch_base ?? "main";
  }
  return { ref, exhausted: true };
}

function isInspectableRef(ref: string): boolean {
  return INSPECTION_BASE_REF_RE.test(ref) && !ref.includes("..") && ref !== "HEAD" && ref !== "@";
}

async function tryRevParse(
  git: (args: readonly string[]) => Promise<string>,
  ref: string,
): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  } catch {
    return undefined;
  }
}

async function resolveMainSha(
  git: (args: readonly string[]) => Promise<string>,
  attemptedRef: string,
): Promise<string> {
  const mainSha = await tryRevParse(git, "main");
  if (mainSha === undefined) {
    throw new Error(`no inspection base resolves (tried ${attemptedRef}, main)`);
  }
  return mainSha;
}

async function fallbackToMain(
  git: (args: readonly string[]) => Promise<string>,
  attemptedRef: string,
  reason: InspectionFallbackReason,
): Promise<ResolvedInspectionBase> {
  const baseSha = await resolveMainSha(git, attemptedRef);
  return { baseRef: "main", baseSha, attemptedRef, fallbackReason: reason };
}

async function resolveInspectionBase(
  git: (args: readonly string[]) => Promise<string>,
  root: { ref: string; exhausted: boolean },
): Promise<ResolvedInspectionBase> {
  const attemptedRef = root.ref;
  if (root.exhausted) {
    return await fallbackToMain(git, attemptedRef, "chain_limit");
  }
  if (root.ref === "main") {
    const baseSha = await resolveMainSha(git, attemptedRef);
    return { baseRef: "main", baseSha, attemptedRef, fallbackReason: null };
  }
  if (!isInspectableRef(root.ref)) {
    return await fallbackToMain(git, attemptedRef, "rejected_ref");
  }
  const sha = await tryRevParse(git, root.ref);
  if (sha !== undefined) {
    return { baseRef: root.ref, baseSha: sha, attemptedRef, fallbackReason: null };
  }
  return await fallbackToMain(git, attemptedRef, "unresolvable");
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
  if (initialDeadline?.expired) return inspectionFailure("worktree inspection deadline expired");
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
    const timeout = remainingMs();
    if (timeout <= 0) throw new Error("worktree inspection deadline expired");
    const result = await runGit(["-c", "core.fsmonitor=false", "-C", canonicalPath, ...args], {
      timeout,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
    return result.stdout;
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

    const { baseRef, baseSha, attemptedRef, fallbackReason } = await resolveInspectionBase(
      git,
      rootInspectionBase(
        services,
        refreshedHandoff.branch_base,
        refreshedHandoff.project_id ?? null,
      ),
    );
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha)) {
      return inspectionFailure(`${baseRef} is not a full Git object id`);
    }
    const comparisonRange = `${baseSha}..${before.headSha}`;
    const diff = await captureGitOutput([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      `${baseSha}...${before.headSha}`,
    ]);
    const log = await captureGitOutput(["log", "--oneline", comparisonRange]);
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
    return { ok: false, code: "inspection_failed", message: errorMessage(err) };
  }
}
