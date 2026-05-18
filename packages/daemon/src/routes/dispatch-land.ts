import { spawn } from 'node:child_process';
import { z } from 'zod';
import { captureAgentPerformanceFromReconciler, type Services } from '@penumbra/core';
import { createGhCliClient, type GhClient } from '../services/gh-client.js';
import { memoryVerifyAuthorizeRoute } from './memory-verify.js';

import { json } from './_helpers.js';
const DispatchLandInputSchema = z.object({
  handoff_id: z.string().min(1),
  commit_message: z.string().min(1),
  mode: z.enum(['squash', 'ff']).optional().default('squash'),
  delete_branch: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
});

interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunGitOpts {
  stdin?: string;
}

type DispatchLandTaskStatus = 'queued' | 'running' | 'done' | 'failed';

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
  gh: Pick<GhClient, 'listOpenPullRequestsByHead' | 'closePullRequest'>;
  now: () => Date;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // ignored
  }
  return {};
}

function subjectFromCommitMessage(message: string): string {
  const first = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? message.trim();
}

const dispatchLandTasks = new Map<string, DispatchLandTaskRecord>();
let dispatchLandQueue: Promise<void> = Promise.resolve();

function createDefaultDeps(services: Services): DispatchLandDeps {
  const repoDir = process.cwd();
  return {
    runGit: (args, opts) =>
      new Promise((resolve, reject) => {
        const proc = spawn('git', ['-C', repoDir, ...args], {
          shell: false,
        });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        proc.on('error', reject);
        if (opts?.stdin != null) {
          proc.stdin?.write(opts.stdin);
        }
        proc.stdin?.end();
        proc.on('close', (code) => {
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
  return verdict.typecheck === 'fail' || verdict.tests === 'fail';
}

function verdictConflictFiles(verdict: Record<string, unknown> | null): string[] | null {
  if (!verdict) return null;
  if (verdict.rebase_result !== 'conflict') return null;
  const raw = verdict.rebase_conflict_files;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

async function closeOpenPrIfAny(
  gh: Pick<GhClient, 'listOpenPullRequestsByHead' | 'closePullRequest'>,
  branch: string,
  commitSha: string,
): Promise<boolean> {
  if (typeof gh.listOpenPullRequestsByHead !== 'function' || typeof gh.closePullRequest !== 'function') {
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

function resolveReviewerHandoffForDispatchLand(services: Services, handoffId: string): string | null {
  const row = services.db.query<{ reviewer_handoff: string | null }, [string]>(
    `SELECT reviewer_handoff
     FROM lane_ledger
     WHERE implementer_handoff = ?
       AND ts_closed IS NOT NULL
       AND reviewer_handoff IS NOT NULL
     ORDER BY ts_closed DESC
     LIMIT 1`,
  ).get(handoffId);
  return row?.reviewer_handoff ?? null;
}

async function authorizeDispatchLandMemoryVerify(input: {
  services: Services;
  handoffId: string;
  reviewerHandoff: string;
  commitSha: string;
}): Promise<void> {
  const req = new Request('http://daemon/memory-verify/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handoff_id: input.handoffId,
      verdict: 'passed',
      basis: {
        kind: 'dispatch_land',
        merge_commit: input.commitSha,
        reviewer_handoff: input.reviewerHandoff,
      },
      authorized_by_handoff: input.reviewerHandoff,
    }),
  });
  const res = await memoryVerifyAuthorizeRoute(req, input.services);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    input.services.log?.warn?.(
      {
        handoff_id: input.handoffId,
        reviewer_handoff: input.reviewerHandoff,
        commit_sha: input.commitSha,
        status: res.status,
        body,
      },
      'dispatch-land memory verify authorize failed',
    );
  }
}

export async function dispatchLandRoute(
  req: Request,
  services: Services,
  deps: DispatchLandDeps = createDefaultDeps(services),
): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = DispatchLandInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }

  const { handoff_id, commit_message, mode, delete_branch, force } = parsed.data;
  const now = typeof (deps as any).now === 'function' ? deps.now : services.clock;
  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }

  const branch = `agent/${handoff_id}`;
  const verdict = readLatestVerdict(services, handoff_id);
  const conflictFiles = verdictConflictFiles(verdict);
  if (!force && conflictFiles !== null) {
    return json({
      error: {
        code: 'merge_conflict',
        files: conflictFiles,
        hint: `rebase ${branch} onto main and retry`,
      },
    }, 409);
  }
  if (!force && verdictFailed(verdict)) {
    return json({ error: { code: 'verdict_unverified', verdict } }, 409);
  }

  const task_id = services.uuid();
  const created_at = now().toISOString();
  const task: DispatchLandTaskRecord = {
    task_id,
    handoff_id,
    status: 'queued',
    created_at,
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
  };
  dispatchLandTasks.set(task_id, task);

  dispatchLandQueue = dispatchLandQueue
    .then(async () => {
      task.status = 'running';
      task.started_at = now().toISOString();
      const outcome = await executeLand({
        services,
        deps,
        now,
        handoff,
        handoff_id,
        commit_message,
        mode,
        delete_branch,
      });
      task.finished_at = now().toISOString();
      if ('error' in outcome) {
        task.status = 'failed';
        task.error = outcome.error;
      } else {
        task.status = 'done';
        task.result = outcome;
      }
    })
    .catch((error) => {
      task.status = 'failed';
      task.finished_at = now().toISOString();
      task.error = {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      };
    });

  return json({
    ok: true,
    task_id,
    status: task.status,
  }, 202);
}

export async function dispatchLandTaskRoute(
  _req: Request,
  _services: Services,
  taskId: string,
): Promise<Response> {
  const task = dispatchLandTasks.get(taskId);
  if (!task) {
    return json({ error: { code: 'not_found', message: `dispatch-land task ${taskId} not found` } }, 404);
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
  handoff: ReturnType<Services['handoffReader']['get']>;
  handoff_id: string;
  commit_message: string;
  mode: 'squash' | 'ff';
  delete_branch: boolean;
}): Promise<DispatchLandSuccess | DispatchLandFailure> {
  const { services, deps, now, handoff_id, commit_message, mode, delete_branch } = input;
  const handoff = input.handoff;
  if (!handoff) {
    return {
      status: 404,
      error: { code: 'not_found', message: `handoff ${handoff_id} not found` },
    };
  }

  const message_subject = subjectFromCommitMessage(commit_message);
  const beforeMain = await deps.runGit(['rev-parse', 'main']);
  if (beforeMain.code !== 0) {
    return {
      status: 500,
      error: {
        code: 'git_failed',
        step: 'rev_parse_main_before',
        stderr: beforeMain.stderr.trim() || undefined,
      },
    };
  }

  const branch = `agent/${handoff_id}`;
  if (mode === 'squash') {
    const checkout = await deps.runGit(['checkout', 'main']);
    if (checkout.code !== 0) {
      return {
        status: 500,
        error: {
          code: 'git_failed',
          step: 'checkout_main',
          stderr: checkout.stderr.trim() || undefined,
        },
      };
    }

    const merge = await deps.runGit(['merge', '--squash', branch]);
    if (merge.code !== 0) {
      const conflicts = await deps.runGit(['diff', '--name-only', '--diff-filter=U']);
      const files = conflicts.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (files.length > 0) {
        await deps.runGit(['merge', '--abort']);
        return {
          status: 409,
          error: {
            code: 'merge_conflict',
            files,
            hint: `rebase ${branch} onto main and retry`,
          },
        };
      }
      return {
        status: 500,
        error: {
          code: 'git_failed',
          step: 'merge_squash',
          stderr: merge.stderr.trim() || undefined,
        },
      };
    }

    const commit = await deps.runGit(['commit', '-F', '-'], { stdin: commit_message });
    if (commit.code !== 0) {
      return {
        status: 500,
        error: {
          code: 'git_failed',
          step: 'commit_squash',
          stderr: commit.stderr.trim() || undefined,
        },
      };
    }
  } else {
    const merge = await deps.runGit(['merge', '--ff-only', `agent/${handoff_id}`]);
    if (merge.code !== 0) {
      return {
        status: 500,
        error: {
          code: 'git_failed',
          step: 'merge_ff_only',
          stderr: merge.stderr.trim() || undefined,
        },
      };
    }
  }

  const afterMain = await deps.runGit(['rev-parse', 'main']);
  if (afterMain.code !== 0) {
    return {
      status: 500,
      error: {
        code: 'git_failed',
        step: 'rev_parse_main_after',
        stderr: afterMain.stderr.trim() || undefined,
      },
    };
  }
  const commit_sha = afterMain.stdout.trim();
  const landed_at = now().toISOString();

  services.t0Writer.write({
    event_id: services.uuid(),
    ts: landed_at,
    ingest_ts: landed_at,
    source: 'mcp',
    source_detail: 'dispatch-land',
    project_id: handoff.project_id,
    user_id: 'penumbra',
    machine_id: services.machineId.get(),
    session_id: handoff.conversation_id,
    event_type: 'dispatch.landed',
    lane: 'local',
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    origin: 'dispatch',
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

  let branch_deleted = false;
  if (delete_branch) {
    const del = await deps.runGit(['branch', '-D', `agent/${handoff_id}`]);
    branch_deleted = del.code === 0;
  }

  const pr_closed = await closeOpenPrIfAny(deps.gh, `agent/${handoff_id}`, commit_sha).catch(() => false);

  try {
    captureAgentPerformanceFromReconciler({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: {
        handoff_id,
        result: { status: 'merged', timed_out: false },
      },
    });
  } catch (err) {
    services.log?.warn?.(
      { handoff_id, err: String(err) },
      'dispatch-land agent_performance re-stamp failed',
    );
  }

  const reviewerHandoff = resolveReviewerHandoffForDispatchLand(services, handoff_id);
  if (reviewerHandoff) {
    await authorizeDispatchLandMemoryVerify({
      services,
      handoffId: handoff_id,
      reviewerHandoff,
      commitSha: commit_sha,
    });
  }

  return {
    ok: true,
    commit_sha,
    message_subject,
    branch_deleted,
    pr_closed,
  };
}
