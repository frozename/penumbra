import { spawn } from "node:child_process";
import { z } from "zod";
import { captureAgentPerformanceFromReconciler, type Services } from "@penumbra/core";
import { stampAgentPerformanceGateOutcomeForHandoff } from "../../../core/src/db/lane-ledger.js";
import { createGhCliClient, type GhClient } from "../services/gh-client.js";
import { memoryVerifyAuthorizeRoute } from "./memory-verify.js";
import { dispatchAuditRoute } from "./dispatch-audit.js";
import { lifecycleLock } from "../dispatch/lifecycle-lock.js";

import { json } from "./_helpers.js";
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
    const parsed = JSON.parse(raw);
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

function evictTerminalDispatchLandTasks(opts: {
  now: Date;
  ttlMs?: number;
  maxSize?: number;
}): void {
  const ttlMs = opts.ttlMs ?? DISPATCH_LAND_TERMINAL_TTL_MS;
  const maxSize = opts.maxSize ?? DISPATCH_LAND_TASKS_MAX;
  const nowMs = opts.now.getTime();

  // TTL sweep: drop terminal records whose finished_at is older than ttlMs.
  for (const [taskId, record] of dispatchLandTasks) {
    if (!isTerminalDispatchLandStatus(record.status)) continue;
    if (!record.finished_at) continue;
    const finishedMs = Date.parse(record.finished_at);
    if (!Number.isFinite(finishedMs)) continue;
    if (nowMs - finishedMs > ttlMs) {
      dispatchLandTasks.delete(taskId);
    }
  }

  // Capacity cap: while the Map exceeds maxSize, evict the oldest terminal
  // record. In-flight (queued/running) entries are skipped — idempotency and
  // status GETs depend on them.
  if (dispatchLandTasks.size <= maxSize) return;
  const terminals: Array<{ taskId: string; finishedMs: number }> = [];
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
        proc.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        proc.on("error", reject);
        if (opts?.stdin != null) {
          proc.stdin?.write(opts.stdin);
        }
        proc.stdin?.end();
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

function verdictFailed(verdict: Record<string, unknown> | null): boolean {
  if (!verdict) return true;
  return verdict.typecheck === "fail" || verdict.tests === "fail";
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
    const res = await dispatchAuditRoute(
      new Request(`http://daemon/dispatch/audit?handoff_id=${encodeURIComponent(handoffId)}`),
      services,
    );
    if (!res.ok) return false;
    const body = (await res.json()) as {
      report?: { trustworthy?: boolean; recommended_action?: string };
    };
    return body.report?.trustworthy === true && body.report?.recommended_action === "accept";
  } catch {
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
    input.services.log?.warn?.(
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

export async function dispatchLandRoute(
  req: Request,
  services: Services,
  deps?: DispatchLandDeps,
): Promise<Response> {
  const raw = await req.json().catch(() => null);
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
  const repoDir = (() => {
    if (handoff.project_id == null) return process.cwd();
    const project = services.projectRegistry?.get(handoff.project_id);
    return project?.root_path ?? process.cwd();
  })();
  const routeDeps = deps ?? createDefaultDeps(services, repoDir);

  const branch = `agent/${handoff_id}`;
  const verdict = readLatestVerdict(services, handoff_id);
  const conflictFiles = verdictConflictFiles(verdict);
  if (!force && conflictFiles !== null) {
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
  if (!force && verdictFailed(verdict) && !(await isAuditTrustedAccept(services, handoff_id))) {
    return json({ error: { code: "verdict_unverified", verdict } }, 409);
  }
  const stampPassedGateOutcome = !force && !verdictFailed(verdict);

  // Idempotency: return the existing in-flight task for this handoff.
  for (const [existingTaskId, existingTask] of dispatchLandTasks.entries()) {
    if (
      existingTask.handoff_id === handoff_id &&
      (existingTask.status === "queued" || existingTask.status === "running")
    ) {
      return json(
        { ok: true, task_id: existingTaskId, status: existingTask.status, idempotent: true },
        202,
      );
    }
  }

  // Fast-reject when the git-write lock is held and the caller opts into immediate refusal.
  if (reject_if_held && lifecycleLock.isHeld()) {
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

  const task_id = services.uuid();
  const created_at = now().toISOString();
  const task: DispatchLandTaskRecord = {
    task_id,
    handoff_id,
    status: "queued",
    created_at,
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
    .catch((error) => {
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

export async function dispatchLandTaskRoute(
  _req: Request,
  _services: Services,
  taskId: string,
): Promise<Response> {
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

  const branch = `agent/${handoff_id}`;
  let resolvedCommitMessage = commit_message;
  if (!resolvedCommitMessage) {
    const commitMessageFromBranch = await deps.runGit(["log", "-1", "--format=%B", branch]);
    if (commitMessageFromBranch.code !== 0) {
      return {
        status: 500,
        error: {
          code: "git_failed",
          step: "resolve_commit_message",
          stderr: commitMessageFromBranch.stderr.trim() || undefined,
        },
      };
    }
    resolvedCommitMessage = commitMessageFromBranch.stdout.trim();
  }
  const message_subject = subjectFromCommitMessage(resolvedCommitMessage);

  // Acquire the lifecycle lock before any git writes to main.
  // The lock serializes cross-call git writes; the dispatchLandQueue is the
  // same-process fast path. The finally block always releases, so a mid-land
  // crash or throw cannot wedge the lock indefinitely.
  const lockAcquiredAt = Date.now();
  const releaseLock = await lifecycleLock.acquire(handoff_id);
  let commit_sha = "";
  let already_landed = false;
  try {
    const beforeMain = await deps.runGit(["rev-parse", "main"]);
    if (beforeMain.code !== 0) {
      return {
        status: 500,
        error: {
          code: "git_failed",
          step: "rev_parse_main_before",
          stderr: beforeMain.stderr.trim() || undefined,
        },
      };
    }
    const beforeMainSha = beforeMain.stdout.trim();

    if (mode === "squash") {
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

      const merge = await deps.runGit(["merge", "--squash", branch]);
      if (merge.code !== 0) {
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

      const stagedChanges = await deps.runGit(["diff", "--cached", "--quiet"]);
      if (stagedChanges.code === 0) {
        already_landed = true;
      } else {
        const commit = await deps.runGit(["commit", "-F", "-"], { stdin: resolvedCommitMessage });
        if (commit.code !== 0) {
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
      }
    } else {
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

      const merge = await deps.runGit(["merge", "--ff-only", `agent/${handoff_id}`]);
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
    }

    // No cleanup on this exit by design: the merge/commit already succeeded, so
    // there is no staged residue — this is a read failure after a complete land.
    const afterMain = await deps.runGit(["rev-parse", "main"]);
    if (afterMain.code !== 0) {
      return {
        status: 500,
        error: {
          code: "git_failed",
          step: "rev_parse_main_after",
          stderr: afterMain.stderr.trim() || undefined,
        },
      };
    }
    const afterMainSha = afterMain.stdout.trim();
    commit_sha = afterMainSha;

    const moved = afterMainSha !== beforeMainSha;
    if (!moved && mode === "ff") {
      const ancestor = await deps.runGit(["merge-base", "--is-ancestor", branch, "main"]);
      if (ancestor.code === 0) {
        already_landed = true;
      } else {
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
    }
  } finally {
    const held_ms = Date.now() - lockAcquiredAt;
    releaseLock();
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
        payload_summary: `lifecycle lock held ${held_ms}ms for ${handoff_id}`,
      });
    } catch {
      // metric failure is non-fatal
    }
  }

  const landed_at = now().toISOString();

  if (!already_landed) {
    services.t0Writer.write({
      event_id: services.uuid(),
      ts: landed_at,
      ingest_ts: landed_at,
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
        handoff_id,
        conversation_id: handoff.conversation_id,
        mode,
        commit_sha,
        branch,
        message_subject,
        landed_at,
      },
      payload_summary: `landed ${handoff_id} via ${mode} -> ${commit_sha.slice(0, 8)}`,
    });
  }

  const pr_closed = already_landed
    ? false
    : await closeOpenPrIfAny(deps.gh, `agent/${handoff_id}`, commit_sha).catch(() => false);

  let branch_deleted = false;
  let worktree_torn_down = false;
  try {
    const td = (await (services.worktreeManager as any).teardownWorktree(
      handoff_id,
      /*force=*/ false,
      handoff.project_id ?? undefined,
      delete_branch,
    )) as { worktreeRemoved?: boolean; branchDeleted?: boolean } | undefined;
    worktree_torn_down = td?.worktreeRemoved === true;
    branch_deleted = td?.branchDeleted === true;
  } catch (err) {
    services.log?.warn?.(
      { handoff_id, err: String(err) },
      "dispatch-land worktree teardown failed; orphan worktree will need manual GC",
    );
  }

  if (!already_landed) {
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
        stampAgentPerformanceGateOutcomeForHandoff(services.db, handoff_id, "passed");
      }
    } catch (err) {
      services.log?.warn?.(
        { handoff_id, err: String(err) },
        "dispatch-land agent_performance re-stamp failed",
      );
    }
  }

  if (!already_landed) {
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
      services.log?.warn?.(
        { handoff_id, err: String(err) },
        "dispatch-land memory verify authorize threw; land result unaffected",
      );
    }
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
