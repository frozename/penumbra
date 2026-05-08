import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { createGhCliClient, type GhClient } from '../services/gh-client.js';

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

export interface DispatchLandDeps {
  runGit: (args: string[], opts?: RunGitOpts) => Promise<GitExecResult>;
  gh: Pick<GhClient, 'listOpenPullRequestsByHead' | 'closePullRequest'>;
  now: () => Date;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  await gh.closePullRequest(pr.number, {
    comment: `Landed in ${commitSha} via dispatch land.`,
  });
  return true;
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
  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }

  const verdict = readLatestVerdict(services, handoff_id);
  if (!force && verdictFailed(verdict)) {
    return json({ error: { code: 'verdict_unverified', verdict } }, 409);
  }

  const branch = `agent/${handoff_id}`;
  const message_subject = subjectFromCommitMessage(commit_message);
  const beforeMain = await deps.runGit(['rev-parse', 'main']);
  if (beforeMain.code !== 0) {
    return json({
      error: {
        code: 'git_failed',
        step: 'rev_parse_main_before',
        stderr: beforeMain.stderr.trim() || undefined,
      },
    }, 500);
  }

  if (mode === 'squash') {
    const checkout = await deps.runGit(['checkout', 'main']);
    if (checkout.code !== 0) {
      return json({
        error: {
          code: 'git_failed',
          step: 'checkout_main',
          stderr: checkout.stderr.trim() || undefined,
        },
      }, 500);
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
        return json({
          error: {
            code: 'merge_conflict',
            files,
            hint: `rebase ${branch} onto main and retry`,
          },
        }, 409);
      }
      return json({
        error: {
          code: 'git_failed',
          step: 'merge_squash',
          stderr: merge.stderr.trim() || undefined,
        },
      }, 500);
    }

    const commit = await deps.runGit(['commit', '-F', '-'], { stdin: commit_message });
    if (commit.code !== 0) {
      return json({
        error: {
          code: 'git_failed',
          step: 'commit_squash',
          stderr: commit.stderr.trim() || undefined,
        },
      }, 500);
    }
  } else {
    const merge = await deps.runGit(['merge', '--ff-only', branch]);
    if (merge.code !== 0) {
      return json({
        error: {
          code: 'git_failed',
          step: 'merge_ff_only',
          stderr: merge.stderr.trim() || undefined,
        },
      }, 500);
    }
  }

  const afterMain = await deps.runGit(['rev-parse', 'main']);
  if (afterMain.code !== 0) {
    return json({
      error: {
        code: 'git_failed',
        step: 'rev_parse_main_after',
        stderr: afterMain.stderr.trim() || undefined,
      },
    }, 500);
  }
  const commit_sha = afterMain.stdout.trim();
  const landed_at = deps.now().toISOString();

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
    event_type: 'dispatch.landed' as any,
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
    const del = await deps.runGit(['branch', '-D', branch]);
    branch_deleted = del.code === 0;
  }

  const pr_closed = await closeOpenPrIfAny(deps.gh, branch, commit_sha).catch(() => false);

  return json({
    ok: true,
    commit_sha,
    message_subject,
    branch_deleted,
    pr_closed,
  });
}
