import type { WorkflowCtx } from "@penumbra/workflows";

const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type WorktreeInspectFn = NonNullable<WorkflowCtx["worktreeInspect"]>;
type WorktreeInspectReturn = Awaited<ReturnType<WorktreeInspectFn>>;
export type WorktreeInspection = Exclude<WorktreeInspectReturn, null>;

export type WorktreeBindingExpectation = {
  handoffId: string;
  branchName: string;
  projectId: string;
  headSha?: string;
};

export type WorktreeBindingResult =
  | { ok: true; headSha: string; inspection: WorktreeInspection }
  | { ok: false; reason: string; inspection: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function handleReason(
  worktree: Record<string, unknown>,
  expected: WorktreeBindingExpectation,
): string | null {
  if (!isNonemptyString(worktree.handoffId) || worktree.handoffId !== expected.handoffId) {
    return "inspection_handoff_mismatch";
  }
  if (!isNonemptyString(worktree.branchName) || worktree.branchName !== expected.branchName) {
    return "inspection_worktree_branch_mismatch";
  }
  if (worktree.status !== "created") return "inspection_worktree_not_created";
  if (
    !isNonemptyString(worktree.path) ||
    !isNonemptyString(worktree.storageRoot) ||
    !isNonemptyString(worktree.createdAt)
  ) {
    return "inspection_worktree_fields_malformed";
  }
  if (worktree.worktreeMode !== "symlink_mirror" && worktree.worktreeMode !== "isolated_install") {
    return "inspection_worktree_mode_malformed";
  }
  if (worktree.projectId === undefined) return null;
  if (!isNonemptyString(worktree.projectId) || worktree.projectId !== expected.projectId) {
    return "inspection_project_mismatch";
  }
  return null;
}

function snapshotReason(
  value: Record<string, unknown>,
  expected: WorktreeBindingExpectation,
  headSha: string,
): string | null {
  if (!isNonemptyString(value.branch_name) || value.branch_name !== expected.branchName) {
    return "inspection_branch_mismatch";
  }
  if (typeof value.diff_against_main !== "string" || typeof value.branch_log !== "string") {
    return "inspection_evidence_malformed";
  }
  if (expected.headSha !== undefined && headSha !== expected.headSha) {
    return "inspection_head_sha_mismatch";
  }
  if (value.dirty !== false) return "inspection_dirty";
  if (!isRecord(value.truncation)) return "inspection_truncation_malformed";
  if (
    value.truncation.diff_against_main !== false ||
    value.truncation.branch_log !== false ||
    value.truncation.total !== false
  ) {
    return "inspection_truncation_present";
  }
  return null;
}

function invalid(reason: string, inspection: unknown): WorktreeBindingResult {
  return { ok: false, reason, inspection };
}

export function validateWorktreeBinding(
  value: unknown,
  expected: WorktreeBindingExpectation,
): WorktreeBindingResult {
  if (!isRecord(value)) return { ok: false, reason: "inspection_malformed", inspection: value };
  const worktree = value.worktree;
  if (!isRecord(worktree)) return invalid("inspection_worktree_malformed", value);
  const headSha = value.head_sha;
  if (!isNonemptyString(headSha) || !FULL_SHA_RE.test(headSha)) {
    return invalid("inspection_head_sha_malformed", value);
  }
  const reason = handleReason(worktree, expected) ?? snapshotReason(value, expected, headSha);
  if (reason !== null) return invalid(reason, value);
  return {
    ok: true,
    headSha,
    inspection: value as WorktreeInspection,
  };
}

export async function inspectBoundWorktree(
  ctx: WorkflowCtx,
  expected: WorktreeBindingExpectation,
): Promise<WorktreeBindingResult> {
  if (typeof ctx.worktreeInspect !== "function") {
    return { ok: false, reason: "inspection_unavailable", inspection: null };
  }
  let inspection: unknown;
  try {
    inspection = await ctx.worktreeInspect(expected.handoffId);
  } catch {
    return { ok: false, reason: "inspection_failed", inspection: null };
  }
  return validateWorktreeBinding(inspection, expected);
}

export function worktreeBindingFailure(label: string, result: WorktreeBindingResult): string {
  if (result.ok) return "";
  const detail =
    result.reason === "inspection_head_sha_mismatch"
      ? "HEAD changed or does not match the expected immutable SHA"
      : result.reason;
  return `${label} inspection failed: ${detail}`;
}
