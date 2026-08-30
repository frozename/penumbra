import { captureAgentPerformanceFromReconciler, type Services } from "@penumbra/core";
import { spawn } from "node:child_process";
import { z } from "zod";

import { stampAgentPerformanceGateOutcomeForHandoff } from "../../../core/src/db/lane-ledger.js";
import { resolveHandoffBranchName } from "../../../core/src/worktree/branch-name.js";
import { getPrincipal } from "../auth.js";
import { lifecycleLock } from "../dispatch/lifecycle-lock.js";
import { createGhCliClient, type GhClient } from "../services/gh-client.js";
import { json } from "./_helpers.js";
import { dispatchAuditRoute } from "./dispatch-audit.js";
import { memoryVerifyAuthorizeRoute } from "./memory-verify.js";

const DispatchLandInputSchema = z.object({
  handoff_id: z.string().min(1),
  commit_message: z.string().min(1).optional(),
  mode: z.enum(["squash", "ff"]).optional().default("squash"),
  delete_branch: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
  reject_if_held: z.boolean().optional().default(false),
});

interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunGitOpts {
  stdin?: string;
  cwd?: string;
}

type DispatchLandTaskStatus = "queued" | "running" | "done" | "failed";

interface DispatchLandTaskError {
  code: string;
  [key: string]: unknown;
}

interface DispatchLandSuccess {
  ok: true;
  commit_sha: string;
  message_subject: string;
  branch_deleted: boolean;
  pr_closed: boolean;
  worktree_torn_down: boolean;
  already_landed?: boolean;
}

interface DispatchLandFailure {
  status: number;
  error: DispatchLandTaskError;
}

interface DispatchLandTaskRecord {
  task_id: string;
  handoff_id: string;
  status: DispatchLandTaskStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: DispatchLandSuccess | null;
  error: DispatchLandTaskError | null;
}

export interface DispatchLandDeps {
  runGit: (args: string[], opts?: RunGitOpts) => Promise<GitExecResult>;
  gh: Pick<GhClient, "listOpenPullRequestsByHead" | "closePullRequest">;
  now: () => Date;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // ignored
  }
  return {};
}

function subjectFromCommitMessage(message: string): string {
  const first = message
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? message.trim();
}

type GitCleanupResult =
  | { ok: true }
  | {
      ok: false;
      cleanup_step: "reset_merge" | "status_porcelain" | "status_dirty";
      cleanup_stderr?: string;
      cleanup_status?: string;
    };

async function resetMergeAndVerifyClean(deps: DispatchLandDeps): Promise<GitCleanupResult> {
  const reset = await deps.runGit(["reset", "--merge"]);
  if (reset.code !== 0) {
    return {
      ok: false,
      cleanup_step: "reset_merge",
      cleanup_stderr: reset.stderr.trim() || undefined,
    };
  }

  // --untracked-files=no: cleanliness here means the INDEX is clean; the home
  // checkout legitimately carries hundreds of untracked notes that would
  // otherwise fail every cleanup verification.
  const status = await deps.runGit(["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) {
    return {
      ok: false,
      cleanup_step: "status_porcelain",
      cleanup_stderr: status.stderr.trim() || undefined,
    };
  }

  const cleanupStatus = status.stdout.trim();
  if (cleanupStatus.length > 0) {
    return {
      ok: false,
      cleanup_step: "status_dirty",
      cleanup_status: cleanupStatus,
    };
  }

  return { ok: true };
}

async function verifyCleanBeforeLand(deps: DispatchLandDeps): Promise<DispatchLandFailure | null> {
  const status = await deps.runGit(["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) {
    return {
      status: 500,
      error: {
        code: "git_failed",
        step: "status_before_land",
        stderr: status.stderr.trim() || undefined,
      },
    };
  }

  const dirtyStatus = status.stdout.trim();
  if (dirtyStatus.length > 0) {
    return {
      status: 409,
      error: {
        code: "dirty_before_land",
        dirty_status: dirtyStatus,
      },
    };
  }

  return null;
}

function commitFailureLooksLikeHook(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("pre-commit") ||
    normalized.includes("precommit") ||
    normalized.includes("prettier") ||
    normalized.includes("lint-staged") ||
    normalized.includes("husky") ||
    normalized.includes("hook")
  );
}

const dispatchLandTasks = new Map<string, DispatchLandTaskRecord>();
let dispatchLandQueue: Promise<void> = Promise.resolve();

// Terminal (done/failed) records accumulate for status GETs and idempotency
// replies; only the in-flight (queued/running) entries are load-bearing. Bound
// the table with TTL + capacity eviction so the Map cannot grow without limit.
const DISPATCH_LAND_TERMINAL_TTL_MS = 60 * 60 * 1000;
const DISPATCH_LAND_TASKS_MAX = 1000;

function isTerminalDispatchLandStatus(status: DispatchLandTaskStatus): boolean {
  return status === "done" || status === "failed";
}

function runDispatchLandTtlSweep(nowMs: number, ttlMs: number): void {
  for (const [taskId, record] of dispatchLandTasks) {
    if (!isTerminalDispatchLandStatus(record.status)) continue;
    if (!record.finished_at) continue;
    const finishedMs = Date.parse(record.finished_at);
    if (!Number.isFinite(finishedMs)) continue;
    if (nowMs - finishedMs > ttlMs) {
      dispatchLandTasks.delete(taskId);
    }
  }
}

function runDispatchLandCapacitySweep(maxSize: number): void {
  if (dispatchLandTasks.size <= maxSize) return;
  const terminals: { taskId: string; finishedMs: number }[] = [];
  for (const [taskId, record] of dispatchLandTasks) {
    if (!isTerminalDispatchLandStatus(record.status)) continue;
    const parsed = record.finished_at ? Date.parse(record.finished_at) : Number.NaN;
    terminals.push({ taskId, finishedMs: Number.isFinite(parsed) ? parsed : 0 });
  }
  terminals.sort((a, b) => a.finishedMs - b.finishedMs);
  for (const { taskId } of terminals) {
    if (dispatchLandTasks.size <= maxSize) return;
    dispatchLandTasks.delete(taskId);
  }
}

function evictTerminalDispatchLandTasks(opts: {
  now: Date;
  ttlMs?: number;
  maxSize?: number;
}): void {
  const ttlMs = opts.ttlMs ?? DISPATCH_LAND_TERMINAL_TTL_MS;
  const maxSize = opts.maxSize ?? DISPATCH_LAND_TASKS_MAX;
  runDispatchLandTtlSweep(opts.now.getTime(), ttlMs);
  runDispatchLandCapacitySweep(maxSize);
}

// Test-only handle: exposes the module-scoped Map and eviction routine so
// regression tests can exercise the policy without standing up real lands.
export const __dispatchLandInternalsForTest = {
  tasks: dispatchLandTasks,
  evict: evictTerminalDispatchLandTasks,
  TTL_MS: DISPATCH_LAND_TERMINAL_TTL_MS,
  MAX_SIZE: DISPATCH_LAND_TASKS_MAX,
};

function createDefaultDeps(services: Services, repoDir: string): DispatchLandDeps {
  return {
    runGit: (args, opts) =>
      new Promise((resolve, reject) => {
        const cwd = opts?.cwd ?? repoDir;
        const proc = spawn("git", ["-C", cwd, ...args], {
          shell: false,
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        proc.on("error", reject);
        if (opts?.stdin !== undefined) {
          proc.stdin.write(opts.stdin);
        }
        proc.stdin.end();
        proc.on("close", (code) => {
          resolve({
            code: code ?? -1,
            stdout,
            stderr,
          });
        });
      }),
    gh: createGhCliClient(),
    now: services.clock,
  };
}

function readLatestVerdict(services: Services, handoffId: string): Record<string, unknown> | null {
  const row = services.db
    .query<{ payload_json: string }, [string]>(
      `SELECT payload_json
       FROM t0_events
       WHERE event_type='reconciler.verdict'
         AND CAST(json_extract(payload_json, '$.handoff_id') AS TEXT) = ?
       ORDER BY ts DESC, event_id DESC
       LIMIT 1`,
    )
    .get(handoffId);

  if (!row) return null;
  return parseJsonRecord(row.payload_json);
}

// Split the gate condition: an explicit typecheck/tests "fail" is a HARD
// failure that must not be auto-landed even when dispatch_audit is
// trustworthy+accept (only force:true overrides it). A missing/null verdict
// is UNVERIFIED and can be rescued by the audit-accept override.
function verdictHardFail(verdict: Record<string, unknown> | null): boolean {
  if (!verdict) return false;
  return verdict.typecheck === "fail" || verdict.tests === "fail";
}

function verdictHardFailCheck(verdict: Record<string, unknown>): "typecheck" | "tests" {
  return verdict.typecheck === "fail" ? "typecheck" : "tests";
}

async function evaluateCurrentVerdictHardFail(input: {
  verdict: Record<string, unknown> | null;
  branch: string;
  force: boolean;
  deps: DispatchLandDeps;
}): Promise<Response | null> {
  const { verdict, branch, force, deps } = input;
  if (force || !verdict || !verdictHardFail(verdict)) return null;
  const branchHeadResult = await deps.runGit(["rev-parse", branch]);
  if (branchHeadResult.code !== 0) {
    return json(
      {
        error: {
          code: "git_failed",
          step: "resolve_verdict_branch_head",
          stderr: branchHeadResult.stderr.trim() || undefined,
        },
      },
      500,
    );
  }
  const branchHeadSha = branchHeadResult.stdout.trim();
  const verdictHeadSha = typeof verdict.head_sha === "string" ? verdict.head_sha.trim() : "";
  if (verdictHeadSha === "" || verdictHeadSha !== branchHeadSha) return null;
  return json(
    {
      error: {
        code: "verdict_unverified",
        check: verdictHardFailCheck(verdict),
        verdict_head_sha: verdictHeadSha,
        branch_head_sha: branchHeadSha,
        verdict,
      },
    },
    409,
  );
}

function verdictUnverified(verdict: Record<string, unknown> | null): boolean {
  if (verdict === null) return true;
  return verdict.typecheck === "error" || verdict.tests === "error";
}

function verdictConflictFiles(verdict: Record<string, unknown> | null): string[] | null {
  if (!verdict) return null;
  if (verdict.rebase_result !== "conflict") return null;
  const raw = verdict.rebase_conflict_files;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

async function isAuditTrustedAccept(services: Services, handoffId: string): Promise<boolean> {
  try {
    const res = dispatchAuditRoute(
      new Request(`http://daemon/dispatch/audit?handoff_id=${encodeURIComponent(handoffId)}`),
      services,
    );
    if (!res.ok) return false;
    const body = (await res.json()) as {
      report?: { trustworthy?: boolean; recommended_action?: string };
    };
    const report = body.report;
    if (!report) return false;
    return report.trustworthy === true && report.recommended_action === "accept";
  } catch (err) {
    services.log.warn(
      { handoff_id: handoffId, err: String(err) },
      "dispatch-land: audit lookup failed; treating as untrusted",
    );
    return false;
  }
}

async function closeOpenPrIfAny(
  gh: Pick<GhClient, "listOpenPullRequestsByHead" | "closePullRequest">,
  branch: string,
  commitSha: string,
): Promise<boolean> {
  if (
    typeof gh.listOpenPullRequestsByHead !== "function" ||
    typeof gh.closePullRequest !== "function"
  ) {
    return false;
  }
  const prs = await gh.listOpenPullRequestsByHead(branch);
  const pr = prs[0];
  if (!pr) return false;
  await gh.closePullRequest({
    number: pr.number,
    comment: `Landed in ${commitSha} via dispatch land.`,
    deleteBranch: false,
  });
  return true;
}

function resolveReviewerHandoffForDispatchLand(
  services: Services,
  handoffId: string,
): string | null {
  const row = services.db
    .query<{ reviewer_handoff: string | null }, [string]>(
      `SELECT reviewer_handoff
     FROM lane_ledger
     WHERE implementer_handoff = ?
       AND ts_closed IS NOT NULL
       AND reviewer_handoff IS NOT NULL
     ORDER BY ts_closed DESC
     LIMIT 1`,
    )
    .get(handoffId);
  return row?.reviewer_handoff ?? null;
}

async function authorizeDispatchLandMemoryVerify(input: {
  services: Services;
  handoffId: string;
  reviewerHandoff: string;
  commitSha: string;
}): Promise<void> {
  const req = new Request("http://daemon/memory-verify/authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      handoff_id: input.handoffId,
      verdict: "passed",
      basis: {
        kind: "dispatch_land",
        merge_commit: input.commitSha,
        reviewer_handoff: input.reviewerHandoff,
      },
      authorized_by_handoff: input.reviewerHandoff,
    }),
  });
  const res = await memoryVerifyAuthorizeRoute(req, input.services);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    input.services.log.warn(
      {
        handoff_id: input.handoffId,
        reviewer_handoff: input.reviewerHandoff,
        commit_sha: input.commitSha,
        status: res.status,
        body,
      },
      "dispatch-land memory verify authorize failed",
    );
  }
}

type Handoff = NonNullable<ReturnType<Services["handoffReader"]["get"]>>;

function resolveLandRepoDir(services: Services, handoff: Handoff): string {
  if (handoff.project_id === null) return process.cwd();
  const project = services.projectRegistry?.get(handoff.project_id);
  return project?.root_path ?? process.cwd();
}

function evaluateLandVerdictConflict(
  branch: string,
  force: boolean,
  conflictFiles: string[] | null,
): Response | null {
  if (force || conflictFiles === null) return null;
  return json(
    {
      error: {
        code: "merge_conflict",
        files: conflictFiles,
        hint: `rebase ${branch} onto main and retry`,
      },
    },
    409,
  );
}

async function evaluateLandVerdictGates(input: {
  services: Services;
  handoffId: string;
  verdict: Record<string, unknown> | null;
  branch: string;
  force: boolean;
  deps: DispatchLandDeps;
}): Promise<Response | null> {
  const { services, handoffId, verdict, branch, force, deps } = input;
  const conflictResponse = evaluateLandVerdictConflict(
    branch,
    force,
    verdictConflictFiles(verdict),
  );
  if (conflictResponse) return conflictResponse;
  if (force) return null;

  // Hard failure: explicit typecheck/tests=fail. Only force:true can land.
  // dispatch_audit trustworthiness reflects the run's reliability — it must
  // not overrule a reviewer-confirmed failure at this branch head.
  const hardFailResponse = await evaluateCurrentVerdictHardFail({
    verdict,
    branch,
    force,
    deps,
  });
  if (hardFailResponse) return hardFailResponse;

  // Unverified (no reviewer verdict on record): allow dispatch_audit to
  // rescue when the run looks trustworthy + accept.
  if (!verdictUnverified(verdict)) return null;
  if (await isAuditTrustedAccept(services, handoffId)) return null;
  return json({ error: { code: "verdict_unverified", verdict } }, 409);
}

function findInflightLandTaskResponse(handoff_id: string): Response | null {
  for (const [existingTaskId, existingTask] of dispatchLandTasks.entries()) {
    if (existingTask.handoff_id !== handoff_id) continue;
    if (existingTask.status !== "queued" && existingTask.status !== "running") continue;
    return json(
      { ok: true, task_id: existingTaskId, status: existingTask.status, idempotent: true },
      202,
    );
  }
  return null;
}

function buildLifecycleBusyResponse(): Response {
  const holder = lifecycleLock.getHolder();
  const elapsed = holder ? Date.now() - holder.acquired_at : 0;
  return json(
    {
      ok: false,
      error: {
        code: "lifecycle_busy",
        holder: holder?.handoff_id ?? "unknown",
        retry_after_ms: Math.max(1000, lifecycleLock.ttlMs - elapsed),
      },
    },
    200,
  );
}

export async function dispatchLandRoute(
  req: Request,
  services: Services,
  deps?: DispatchLandDeps,
): Promise<Response> {
  const principal = getPrincipal(req);
  if (principal?.kind !== "shared") {
    return json(
      {
        error: {
          code: "principal_forbidden",
          message:
            "dispatch-land is restricted to shared-bearer principals; worker-token callers are not authorized",
        },
      },
      403,
    );
  }

  const raw: unknown = await req.json().catch(() => null);
  const parsed = DispatchLandInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }

  const { handoff_id, commit_message, mode, delete_branch, force, reject_if_held } = parsed.data;
  const now = deps?.now ?? services.clock;
  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: "not_found", message: `handoff ${handoff_id} not found` } }, 404);
  }
  const repoDir = resolveLandRepoDir(services, handoff);
  const routeDeps = deps ?? createDefaultDeps(services, repoDir);

  const branch = resolveHandoffBranchName(handoff);
  const verdict = readLatestVerdict(services, handoff_id);
  const verdictGateResponse = await evaluateLandVerdictGates({
    services,
    handoffId: handoff_id,
    verdict,
    branch,
    force,
    deps: routeDeps,
  });
  if (verdictGateResponse) return verdictGateResponse;
  const stampPassedGateOutcome = !force && !verdictHardFail(verdict) && !verdictUnverified(verdict);

  const inflightResponse = findInflightLandTaskResponse(handoff_id);
  if (inflightResponse) return inflightResponse;

  if (reject_if_held && lifecycleLock.isHeld()) {
    return buildLifecycleBusyResponse();
  }

  const task_id = services.uuid();
  const task: DispatchLandTaskRecord = {
    task_id,
    handoff_id,
    status: "queued",
    created_at: now().toISOString(),
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
  };
  dispatchLandTasks.set(task_id, task);

  dispatchLandQueue = dispatchLandQueue
    .then(async () => {
      task.status = "running";
      task.started_at = now().toISOString();
      const outcome = await executeLand({
        services,
        deps: {
          ...routeDeps,
          runGit: (args, opts) => routeDeps.runGit(args, { ...opts, cwd: repoDir }),
        },
        now,
        handoff,
        handoff_id,
        commit_message,
        mode,
        delete_branch,
        stampPassedGateOutcome,
      });
      task.finished_at = now().toISOString();
      if ("error" in outcome) {
        task.status = "failed";
        task.error = outcome.error;
      } else {
        task.status = "done";
        task.result = outcome;
      }
      evictTerminalDispatchLandTasks({ now: now() });
    })
    .catch((error: unknown) => {
      task.status = "failed";
      task.finished_at = now().toISOString();
      task.error = {
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      };
      evictTerminalDispatchLandTasks({ now: now() });
    });

  return json(
    {
      ok: true,
      task_id,
      status: task.status,
    },
    202,
  );
}

export function dispatchLandTaskRoute(
  _req: Request,
  _services: Services,
  taskId: string,
): Response {
  const task = dispatchLandTasks.get(taskId);
  if (!task) {
    return json(
      { error: { code: "not_found", message: `dispatch-land task ${taskId} not found` } },
      404,
    );
  }
  return json({
    task_id: task.task_id,
    handoff_id: task.handoff_id,
    status: task.status,
    created_at: task.created_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    result: task.result,
    error: task.error,
  });
}

async function resolveLandCommitMessage(
  deps: DispatchLandDeps,
  branch: string,
  override: string | undefined,
): Promise<{ message: string } | DispatchLandFailure> {
  if (override) return { message: override };
  const result = await deps.runGit(["log", "-1", "--format=%B", branch]);
  if (result.code !== 0) {
    return {
      status: 500,
      error: {
        code: "git_failed",
        step: "resolve_commit_message",
        stderr: result.stderr.trim() || undefined,
      },
    };
  }
  return { message: result.stdout.trim() };
}

async function performLandSquashMerge(
  deps: DispatchLandDeps,
  branch: string,
): Promise<DispatchLandFailure | null> {
  const merge = await deps.runGit(["merge", "--squash", branch]);
  if (merge.code === 0) return null;
  const conflicts = await deps.runGit(["diff", "--name-only", "--diff-filter=U"]);
  const files = conflicts.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (files.length > 0) {
    const cleanup = await resetMergeAndVerifyClean(deps);
    if (!cleanup.ok) {
      return {
        status: 500,
        error: {
          code: "merge_conflict_cleanup_failed",
          files,
          hint: `rebase ${branch} onto main and retry`,
          manual_repair: "run git reset --merge in the target repo before retrying",
          ...cleanup,
        },
      };
    }
    return {
      status: 409,
      error: {
        code: "merge_conflict",
        files,
        hint: `rebase ${branch} onto main and retry`,
      },
    };
  }
  // A failed squash can leave partial staged state even when no unmerged
  // paths are reported (or when the conflict read itself failed) — clean
  // up before surfacing the error so the next land never starts dirty.
  const fallbackCleanup = await resetMergeAndVerifyClean(deps);
  return {
    status: 500,
    error: {
      code: "git_failed",
      step: "merge_squash",
      stderr: merge.stderr.trim() || undefined,
      ...(fallbackCleanup.ok ? {} : fallbackCleanup),
    },
  };
}

async function performLandSquashCommit(
  deps: DispatchLandDeps,
  resolvedCommitMessage: string,
): Promise<{ already_landed: boolean } | DispatchLandFailure> {
  const stagedChanges = await deps.runGit(["diff", "--cached", "--quiet"]);
  if (stagedChanges.code === 0) {
    return { already_landed: true };
  }
  const commit = await deps.runGit(["commit", "-F", "-"], { stdin: resolvedCommitMessage });
  if (commit.code === 0) {
    return { already_landed: false };
  }
  const stderr = commit.stderr.trim();
  const cleanup = await resetMergeAndVerifyClean(deps);
  if (!cleanup.ok) {
    return {
      status: 500,
      error: {
        code: commitFailureLooksLikeHook(stderr)
          ? "commit_hook_cleanup_failed"
          : "commit_cleanup_failed",
        step: "commit_squash",
        stderr: stderr || undefined,
        manual_repair: "run git reset --merge in the target repo before retrying",
        ...cleanup,
      },
    };
  }
  if (commitFailureLooksLikeHook(stderr)) {
    return {
      status: 500,
      error: {
        code: "commit_hook_failed",
        step: "commit_squash",
        stderr: stderr || undefined,
      },
    };
  }
  return {
    status: 500,
    error: {
      code: "git_failed",
      step: "commit_squash",
      stderr: stderr || undefined,
    },
  };
}

async function performLandSquashFlow(
  deps: DispatchLandDeps,
  branch: string,
  resolvedCommitMessage: string,
): Promise<{ already_landed: boolean } | DispatchLandFailure> {
  const dirtyFailure = await verifyCleanBeforeLand(deps);
  if (dirtyFailure) return dirtyFailure;
  const checkoutFailure = await performLandCheckoutMain(deps);
  if (checkoutFailure) return checkoutFailure;
  const mergeFailure = await performLandSquashMerge(deps, branch);
  if (mergeFailure) return mergeFailure;
  return await performLandSquashCommit(deps, resolvedCommitMessage);
}

async function performLandFfFlow(
  deps: DispatchLandDeps,
  branch: string,
): Promise<DispatchLandFailure | null> {
  const dirtyFailure = await verifyCleanBeforeLand(deps);
  if (dirtyFailure) return dirtyFailure;
  const checkoutFailure = await performLandCheckoutMain(deps);
  if (checkoutFailure) return checkoutFailure;
  const merge = await deps.runGit(["merge", "--ff-only", branch]);
  if (merge.code !== 0) {
    return {
      status: 500,
      error: {
        code: "git_failed",
        step: "merge_ff_only",
        stderr: merge.stderr.trim() || undefined,
      },
    };
  }
  return null;
}

async function performLandCheckoutMain(
  deps: DispatchLandDeps,
): Promise<DispatchLandFailure | null> {
  const checkout = await deps.runGit(["checkout", "main"]);
  if (checkout.code !== 0) {
    return {
      status: 500,
      error: {
        code: "git_failed",
        step: "checkout_main",
        stderr: checkout.stderr.trim() || undefined,
      },
    };
  }
  return null;
}

async function readMainSha(
  deps: DispatchLandDeps,
  step: "rev_parse_main_before" | "rev_parse_main_after",
): Promise<{ sha: string } | DispatchLandFailure> {
  const result = await deps.runGit(["rev-parse", "main"]);
  if (result.code !== 0) {
    return {
      status: 500,
      error: {
        code: "git_failed",
        step,
        stderr: result.stderr.trim() || undefined,
      },
    };
  }
  return { sha: result.stdout.trim() };
}

async function verifyLandedFfMove(
  deps: DispatchLandDeps,
  branch: string,
  beforeMainSha: string,
  afterMainSha: string,
): Promise<{ already_landed: boolean } | DispatchLandFailure> {
  if (afterMainSha !== beforeMainSha) return { already_landed: false };
  const ancestor = await deps.runGit(["merge-base", "--is-ancestor", branch, "main"]);
  if (ancestor.code === 0) return { already_landed: true };
  return {
    status: 500,
    error: {
      code: "land_not_in_main",
      step: "verify_landed",
      beforeMain: beforeMainSha,
      afterMain: afterMainSha,
      stderr: ancestor.stderr.trim() || undefined,
    },
  };
}

interface PerformLandGitOpsResult {
  commit_sha: string;
  already_landed: boolean;
}

async function performLandGitOps(
  deps: DispatchLandDeps,
  branch: string,
  mode: "squash" | "ff",
  resolvedCommitMessage: string,
): Promise<PerformLandGitOpsResult | DispatchLandFailure> {
  const before = await readMainSha(deps, "rev_parse_main_before");
  if ("error" in before) return before;

  let already_landed = false;
  if (mode === "squash") {
    const squash = await performLandSquashFlow(deps, branch, resolvedCommitMessage);
    if ("error" in squash) return squash;
    already_landed = squash.already_landed;
  } else {
    const ff = await performLandFfFlow(deps, branch);
    if (ff) return ff;
  }

  // No cleanup on this exit by design: the merge/commit already succeeded, so
  // there is no staged residue — this is a read failure after a complete land.
  const after = await readMainSha(deps, "rev_parse_main_after");
  if ("error" in after) return after;

  if (mode === "ff") {
    const verified = await verifyLandedFfMove(deps, branch, before.sha, after.sha);
    if ("error" in verified) return verified;
    already_landed = verified.already_landed;
  }

  return { commit_sha: after.sha, already_landed };
}

function writeLifecycleLockMetric(
  services: Services,
  handoff: Handoff,
  handoff_id: string,
  held_ms: number,
): void {
  try {
    const metricTs = new Date().toISOString();
    services.t0Writer.write({
      event_id: services.uuid(),
      ts: metricTs,
      ingest_ts: metricTs,
      source: "mcp",
      source_detail: "dispatch-land",
      project_id: handoff.project_id,
      user_id: "penumbra",
      machine_id: services.machineId.get(),
      session_id: handoff.conversation_id,
      event_type: "lifecycle_lock_held",
      lane: "local",
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      latency_ms: held_ms,
      request_id: null,
      origin: "dispatch",
      payload_json: { handoff_id, held_ms },
      payload_summary: `lifecycle lock held ${String(held_ms)}ms for ${handoff_id}`,
    });
  } catch {
    // metric failure is non-fatal
  }
}

function writeDispatchLandedEvent(
  services: Services,
  handoff: Handoff,
  input: {
    handoff_id: string;
    branch: string;
    commit_sha: string;
    message_subject: string;
    mode: "squash" | "ff";
    landed_at: string;
  },
): void {
  services.t0Writer.write({
    event_id: services.uuid(),
    ts: input.landed_at,
    ingest_ts: input.landed_at,
    source: "mcp",
    source_detail: "dispatch-land",
    project_id: handoff.project_id,
    user_id: "penumbra",
    machine_id: services.machineId.get(),
    session_id: handoff.conversation_id,
    event_type: "dispatch.landed",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    origin: "dispatch",
    payload_json: {
      handoff_id: input.handoff_id,
      conversation_id: handoff.conversation_id,
      mode: input.mode,
      commit_sha: input.commit_sha,
      branch: input.branch,
      message_subject: input.message_subject,
      landed_at: input.landed_at,
    },
    payload_summary: `landed ${input.handoff_id} via ${input.mode} -> ${input.commit_sha.slice(0, 8)}`,
  });
}

async function teardownLandWorktree(
  services: Services,
  handoff: Handoff,
  handoff_id: string,
  delete_branch: boolean,
): Promise<{ worktree_torn_down: boolean; branch_deleted: boolean }> {
  try {
    const td = await services.worktreeManager.teardownWorktree(
      handoff_id,
      false,
      handoff.project_id ?? undefined,
      delete_branch,
    );
    return { worktree_torn_down: td.worktreeRemoved, branch_deleted: td.branchDeleted };
  } catch (err) {
    services.log.warn(
      { handoff_id, err: String(err) },
      "dispatch-land worktree teardown failed; orphan worktree will need manual GC",
    );
    return { worktree_torn_down: false, branch_deleted: false };
  }
}

function captureLandAgentPerformance(
  services: Services,
  handoff_id: string,
  stampPassedGateOutcome: boolean,
): void {
  try {
    captureAgentPerformanceFromReconciler({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: {
        handoff_id,
        result: { status: "merged", timed_out: false },
      },
    });
    if (stampPassedGateOutcome) {
      stampAgentPerformanceGateOutcomeForHandoff(services.db, handoff_id, "passed", services.log);
    }
  } catch (err) {
    services.log.warn(
      { handoff_id, err: String(err) },
      "dispatch-land agent_performance re-stamp failed",
    );
  }
}

async function runLandMemoryVerify(
  services: Services,
  handoff_id: string,
  commit_sha: string,
): Promise<void> {
  try {
    const reviewerHandoff = resolveReviewerHandoffForDispatchLand(services, handoff_id);
    if (reviewerHandoff) {
      await authorizeDispatchLandMemoryVerify({
        services,
        handoffId: handoff_id,
        reviewerHandoff,
        commitSha: commit_sha,
      });
    }
  } catch (err) {
    services.log.warn(
      { handoff_id, err: String(err) },
      "dispatch-land memory verify authorize threw; land result unaffected",
    );
  }
}

async function executeLand(input: {
  services: Services;
  deps: DispatchLandDeps;
  now: () => Date;
  handoff: ReturnType<Services["handoffReader"]["get"]>;
  handoff_id: string;
  commit_message?: string;
  mode: "squash" | "ff";
  delete_branch: boolean;
  stampPassedGateOutcome: boolean;
}): Promise<DispatchLandSuccess | DispatchLandFailure> {
  const {
    services,
    deps,
    now,
    handoff_id,
    commit_message,
    mode,
    delete_branch,
    stampPassedGateOutcome,
  } = input;
  const handoff = input.handoff;
  if (!handoff) {
    return {
      status: 404,
      error: { code: "not_found", message: `handoff ${handoff_id} not found` },
    };
  }

  const branch = resolveHandoffBranchName(handoff);
  const messageResult = await resolveLandCommitMessage(deps, branch, commit_message);
  if ("error" in messageResult) return messageResult;
  const resolvedCommitMessage = messageResult.message;
  const message_subject = subjectFromCommitMessage(resolvedCommitMessage);

  // Acquire the lifecycle lock before any git writes to main.
  // The lock serializes cross-call git writes; the dispatchLandQueue is the
  // same-process fast path. The finally block always releases, so a mid-land
  // crash or throw cannot wedge the lock indefinitely.
  const lockAcquiredAt = Date.now();
  const releaseLock = await lifecycleLock.acquire(handoff_id);
  let gitOpsOutcome: PerformLandGitOpsResult | DispatchLandFailure;
  try {
    gitOpsOutcome = await performLandGitOps(deps, branch, mode, resolvedCommitMessage);
  } finally {
    const held_ms = Date.now() - lockAcquiredAt;
    releaseLock();
    writeLifecycleLockMetric(services, handoff, handoff_id, held_ms);
  }

  if ("error" in gitOpsOutcome) return gitOpsOutcome;
  const { commit_sha, already_landed } = gitOpsOutcome;

  const landed_at = now().toISOString();
  if (!already_landed) {
    writeDispatchLandedEvent(services, handoff, {
      handoff_id,
      branch,
      commit_sha,
      message_subject,
      mode,
      landed_at,
    });
  }

  const pr_closed = already_landed
    ? false
    : await closeOpenPrIfAny(deps.gh, branch, commit_sha).catch(() => false);

  const { worktree_torn_down, branch_deleted } = await teardownLandWorktree(
    services,
    handoff,
    handoff_id,
    delete_branch,
  );

  if (!already_landed) {
    captureLandAgentPerformance(services, handoff_id, stampPassedGateOutcome);
    await runLandMemoryVerify(services, handoff_id, commit_sha);
  }

  return {
    ok: true,
    commit_sha,
    message_subject,
    branch_deleted,
    pr_closed,
    worktree_torn_down,
    ...(already_landed ? { already_landed: true } : {}),
  };
}
