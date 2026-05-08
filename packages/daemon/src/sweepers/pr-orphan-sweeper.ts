import { spawn } from 'node:child_process';
import type { Database } from 'bun:sqlite';

const AGENT_HEAD_RE = /^agent\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7;
const MIN_AGE_DAYS = 1;
const DEFAULT_INTERVAL_MS = 21_600_000; // 6h

export type SweepReason = 'superseded' | 'stale';
export type SweepActionKind = 'closed_and_deleted' | 'closed' | 'dry_run_superseded' | 'dry_run_stale';

export interface OpenPullRequest {
  number: number;
  title?: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
}

export interface ClosePullRequestInput {
  number: number;
  comment: string;
  deleteBranch: boolean;
}

export interface GhClient {
  listOpenPullRequests(): Promise<OpenPullRequest[]>;
  closePullRequest(input: ClosePullRequestInput): Promise<void>;
}

export interface GitClient {
  resolveMainSha(): Promise<string>;
  isAncestorOfMain(headSha: string): Promise<boolean>;
}

export interface SweeperEventWriter {
  write(row: any): void;
}

export interface PrOrphanSweeperDeps {
  ghClient: GhClient;
  gitClient: GitClient;
  t0Writer: SweeperEventWriter;
  uuid: () => string;
  clock: () => Date;
  machineId: { get(): string };
  dryRun: boolean;
  maxClose?: number;
  projectId?: string | null;
  log?: { info?: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
}

export interface PrSweepAction {
  pr_number: number;
  action: SweepActionKind;
  reason: SweepReason;
  comment: string;
  head_ref: string;
  head_sha: string;
  age_days: number;
  main_sha?: string;
}

export interface PrSweepResult {
  scanned: number;
  superseded: number;
  stale: number;
  errored: number;
  actions: PrSweepAction[];
}

export interface InstallPrOrphanSweeperOpts {
  db: Database;
  intervalMs?: number;
  ghClient?: GhClient;
  gitClient?: GitClient;
  t0Writer: SweeperEventWriter;
  uuid: () => string;
  clock: () => Date;
  machineId: { get(): string };
  log?: { info?: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
  dryRun?: boolean;
  maxClose?: number;
  applyDefault?: boolean;
  projectId?: string | null;
  repoDir?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(file: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export function createGhCliClient(opts: { repoDir?: string } = {}): GhClient {
  const repoDir = opts.repoDir ?? process.cwd();
  return {
    async listOpenPullRequests(): Promise<OpenPullRequest[]> {
      const res = await run(
        'gh',
        ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,headRefOid,updatedAt', '--limit', '500'],
        repoDir,
      );
      if (res.code !== 0) {
        throw new Error(`gh pr list failed (${res.code}): ${res.stderr.slice(0, 500)}`);
      }
      const parsed = JSON.parse(res.stdout || '[]') as OpenPullRequest[];
      return parsed;
    },

    async closePullRequest(input: ClosePullRequestInput): Promise<void> {
      const args = ['pr', 'close', String(input.number), '--comment', input.comment];
      if (input.deleteBranch) args.push('--delete-branch');
      const res = await run('gh', args, repoDir);
      if (res.code !== 0) {
        throw new Error(`gh pr close failed (${res.code}): ${res.stderr.slice(0, 500)}`);
      }
    },
  };
}

export function createGitCliClient(opts: { repoDir?: string } = {}): GitClient {
  const repoDir = opts.repoDir ?? process.cwd();
  return {
    async resolveMainSha(): Promise<string> {
      const res = await run('git', ['rev-parse', 'main'], repoDir);
      if (res.code !== 0) {
        throw new Error(`git rev-parse main failed (${res.code}): ${res.stderr.slice(0, 500)}`);
      }
      return res.stdout.trim();
    },

    async isAncestorOfMain(headSha: string): Promise<boolean> {
      const res = await run('git', ['merge-base', '--is-ancestor', headSha, 'main'], repoDir);
      if (res.code === 0) return true;
      if (res.code === 1) return false;
      throw new Error(`git merge-base --is-ancestor failed (${res.code}): ${res.stderr.slice(0, 500)}`);
    },
  };
}

function ageDays(nowMs: number, updatedAt: string): number {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return Number.POSITIVE_INFINITY;
  return Math.floor((nowMs - updatedMs) / MS_PER_DAY);
}

function emitSweepEvent(
  deps: PrOrphanSweeperDeps,
  nowIso: string,
  action: PrSweepAction,
): void {
  deps.t0Writer.write({
    event_id: deps.uuid(),
    ts: nowIso,
    ingest_ts: nowIso,
    source: 'mcp',
    source_detail: 'pr-orphan-sweeper',
    project_id: deps.projectId ?? null,
    user_id: 'penumbra',
    machine_id: deps.machineId.get(),
    session_id: 'sweeper',
    event_type: 'reconciler.pr.swept',
    lane: 'unknown',
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    origin: null,
    payload_json: {
      pr_number: action.pr_number,
      head_ref: action.head_ref,
      head_sha: action.head_sha,
      reason: action.reason,
      main_sha: action.main_sha,
      age_days: action.age_days,
      action: action.action,
    },
    payload_summary: `pr #${action.pr_number} ${action.reason} ${action.action}`,
  });
}

export async function runPrOrphanSweep(deps: PrOrphanSweeperDeps): Promise<PrSweepResult> {
  const now = deps.clock();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const mainSha = await deps.gitClient.resolveMainSha();

  const actions: PrSweepAction[] = [];
  let scanned = 0;
  let superseded = 0;
  let stale = 0;
  let errored = 0;

  const prs = await deps.ghClient.listOpenPullRequests();
  for (const row of prs) {
    if (!AGENT_HEAD_RE.test(row.headRefName)) continue;
    scanned += 1;

    try {
      const days = ageDays(nowMs, row.updatedAt);
      if (days < MIN_AGE_DAYS) continue;

      const isAncestor = await deps.gitClient.isAncestorOfMain(row.headRefOid);
      if (isAncestor) {
        const comment = `Superseded: head commit ${row.headRefOid} is reachable from main as ${mainSha}. Closing.`;
        const action: PrSweepAction = {
          pr_number: row.number,
          action: deps.dryRun ? 'dry_run_superseded' : 'closed_and_deleted',
          reason: 'superseded',
          comment,
          head_ref: row.headRefName,
          head_sha: row.headRefOid,
          age_days: days,
          main_sha: mainSha,
        };

        if (!deps.dryRun) {
          await deps.ghClient.closePullRequest({
            number: row.number,
            comment,
            deleteBranch: true,
          });
        }
        emitSweepEvent(deps, nowIso, action);
        actions.push(action);
        superseded += 1;
        if (deps.maxClose != null && actions.length >= deps.maxClose) break;
        continue;
      }

      if (days > STALE_DAYS) {
        const comment = `Stale: no activity for ${days} days; closing as abandoned. Reopen if needed.`;
        const action: PrSweepAction = {
          pr_number: row.number,
          action: deps.dryRun ? 'dry_run_stale' : 'closed',
          reason: 'stale',
          comment,
          head_ref: row.headRefName,
          head_sha: row.headRefOid,
          age_days: days,
        };

        if (!deps.dryRun) {
          await deps.ghClient.closePullRequest({
            number: row.number,
            comment,
            deleteBranch: false,
          });
        }
        emitSweepEvent(deps, nowIso, action);
        actions.push(action);
        stale += 1;
        if (deps.maxClose != null && actions.length >= deps.maxClose) break;
      }
    } catch (error) {
      errored += 1;
      deps.log?.warn?.({ err: String(error), pr_number: row.number, head_ref: row.headRefName }, 'pr-orphan-sweeper: failed PR');
    }
  }

  deps.log?.info?.(
    { scanned, superseded, stale, errored, dry_run: deps.dryRun },
    `pr-orphan-sweeper: scanned ${scanned}, superseded ${superseded}, stale ${stale}, errored ${errored}`,
  );

  return { scanned, superseded, stale, errored, actions };
}

export function installPrOrphanSweeper(opts: InstallPrOrphanSweeperOpts): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const dryRun = opts.dryRun ?? (opts.applyDefault !== false);
  const ghClient = opts.ghClient ?? createGhCliClient({ repoDir: opts.repoDir });
  const gitClient = opts.gitClient ?? createGitCliClient({ repoDir: opts.repoDir });

  const timer = setInterval(() => {
    void runPrOrphanSweep({
      ghClient,
      gitClient,
      t0Writer: opts.t0Writer,
      uuid: opts.uuid,
      clock: opts.clock,
      machineId: opts.machineId,
      dryRun,
      maxClose: opts.maxClose,
      log: opts.log,
      projectId: opts.projectId,
    }).catch((error) => {
      opts.log?.warn?.({ err: String(error) }, 'pr-orphan-sweeper tick failed');
    });
  }, intervalMs);

  if (typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }

  return {
    stop: () => clearInterval(timer),
  };
}
