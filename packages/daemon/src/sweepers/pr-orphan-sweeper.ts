import { spawn } from "node:child_process";
import type { Database } from "bun:sqlite";
import {
  createGhCliClient,
  type GhClient as CanonicalGhClient,
  type GhOpenPullRequest,
} from "../services/gh-client.js";

const AGENT_HEAD_RE = /^agent\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7;
const MIN_AGE_DAYS = 1;
const DEFAULT_INTERVAL_MS = 21_600_000; // 6h
const SWEEP_BATCH_SIZE = 6;

export type SweepReason = "superseded" | "stale";
export type SweepActionKind =
  | "closed_and_deleted"
  | "closed"
  | "dry_run_superseded"
  | "dry_run_stale";

export type OpenPullRequest = GhOpenPullRequest;
export type GhClient = Required<
  Pick<CanonicalGhClient, "listOpenPullRequests" | "closePullRequest">
>;

export interface GitClient {
  resolveMainSha(): Promise<string>;
  isAncestorOfMain(headSha: string): Promise<boolean>;
  isObjectReachable(headSha: string): Promise<boolean>;
  fetchHeadRef(headRef: string): Promise<void>;
  isThreeDotDiffEmptyVsMain(headSha: string): Promise<boolean>;
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
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
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
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
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
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export function createGitCliClient(opts: { repoDir?: string } = {}): GitClient {
  const repoDir = opts.repoDir ?? process.cwd();
  return {
    async resolveMainSha(): Promise<string> {
      const res = await run("git", ["rev-parse", "main"], repoDir);
      if (res.code !== 0) {
        throw new Error(`git rev-parse main failed (${res.code}): ${res.stderr.slice(0, 500)}`);
      }
      return res.stdout.trim();
    },

    async isAncestorOfMain(headSha: string): Promise<boolean> {
      const res = await run("git", ["merge-base", "--is-ancestor", headSha, "main"], repoDir);
      if (res.code === 0) return true;
      if (res.code === 1) return false;
      throw new Error(
        `git merge-base --is-ancestor failed (${res.code}): ${res.stderr.slice(0, 500)}`,
      );
    },

    async isObjectReachable(headSha: string): Promise<boolean> {
      const res = await run("git", ["cat-file", "-e", `${headSha}^{commit}`], repoDir);
      if (res.code === 0) return true;
      if (res.code === 1 || res.code === 128) return false;
      throw new Error(`git cat-file -e failed (${res.code}): ${res.stderr.slice(0, 500)}`);
    },

    async fetchHeadRef(headRef: string): Promise<void> {
      const res = await run("git", ["fetch", "origin", headRef], repoDir);
      if (res.code !== 0) {
        throw new Error(
          `git fetch origin ${headRef} failed (${res.code}): ${res.stderr.slice(0, 500)}`,
        );
      }
    },

    async isThreeDotDiffEmptyVsMain(headSha: string): Promise<boolean> {
      const res = await run("git", ["diff", "--stat", `main...${headSha}`], repoDir);
      if (res.code !== 0) {
        throw new Error(
          `git diff --stat main...${headSha} failed (${res.code}): ${res.stderr.slice(0, 500)}`,
        );
      }
      return res.stdout.trim().length === 0;
    },
  };
}

function ageDays(nowMs: number, updatedAt: string): number {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return Number.POSITIVE_INFINITY;
  return Math.floor((nowMs - updatedMs) / MS_PER_DAY);
}

function emitSweepEvent(deps: PrOrphanSweeperDeps, nowIso: string, action: PrSweepAction): void {
  deps.t0Writer.write({
    event_id: deps.uuid(),
    ts: nowIso,
    ingest_ts: nowIso,
    source: "mcp",
    source_detail: "pr-orphan-sweeper",
    project_id: deps.projectId ?? null,
    user_id: "penumbra",
    machine_id: deps.machineId.get(),
    session_id: "sweeper",
    event_type: "reconciler.pr.swept",
    lane: "unknown",
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

  const prs = (await deps.ghClient.listOpenPullRequests()).filter((row) =>
    AGENT_HEAD_RE.test(row.headRefName),
  );
  scanned = prs.length;

  const processRow = async (row: OpenPullRequest): Promise<PrSweepAction | null> => {
    const days = ageDays(nowMs, row.updatedAt);
    if (days < MIN_AGE_DAYS) return null;

    const isAncestor = await deps.gitClient.isAncestorOfMain(row.headRefOid);
    if (isAncestor) {
      const comment = `Superseded: head commit ${row.headRefOid} is reachable from main as ${mainSha}. Closing.`;
      const action: PrSweepAction = {
        pr_number: row.number,
        action: deps.dryRun ? "dry_run_superseded" : "closed_and_deleted",
        reason: "superseded",
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
      return action;
    }

    const hasHeadObject = await deps.gitClient.isObjectReachable(row.headRefOid);
    if (!hasHeadObject) {
      await deps.gitClient.fetchHeadRef(row.headRefName);
    }
    const isDiffEmpty = await deps.gitClient.isThreeDotDiffEmptyVsMain(row.headRefOid);
    if (isDiffEmpty) {
      const comment = `Superseded: head commit ${row.headRefOid} diff vs main is empty (work landed via rebase/cherry-pick). Closing.`;
      const action: PrSweepAction = {
        pr_number: row.number,
        action: deps.dryRun ? "dry_run_superseded" : "closed_and_deleted",
        reason: "superseded",
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
      return action;
    }

    if (days > STALE_DAYS) {
      const comment = `Stale: no activity for ${days} days; closing as abandoned. Reopen if needed.`;
      const action: PrSweepAction = {
        pr_number: row.number,
        action: deps.dryRun ? "dry_run_stale" : "closed",
        reason: "stale",
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
      return action;
    }

    return null;
  };

  if (deps.maxClose != null) {
    for (const row of prs) {
      try {
        const action = await processRow(row);
        if (!action) continue;
        actions.push(action);
        if (action.reason === "superseded") superseded += 1;
        else stale += 1;
        if (actions.length >= deps.maxClose) break;
      } catch (error) {
        errored += 1;
        deps.log?.warn?.(
          { err: String(error), pr_number: row.number, head_ref: row.headRefName },
          "pr-orphan-sweeper: failed PR",
        );
      }
    }
  } else {
    for (let i = 0; i < prs.length; i += SWEEP_BATCH_SIZE) {
      const batch = prs.slice(i, i + SWEEP_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (row) => {
          try {
            return { row, action: await processRow(row), error: null as unknown };
          } catch (error) {
            return { row, action: null, error };
          }
        }),
      );
      for (const result of results) {
        if (result.error) {
          errored += 1;
          deps.log?.warn?.(
            {
              err: String(result.error),
              pr_number: result.row.number,
              head_ref: result.row.headRefName,
            },
            "pr-orphan-sweeper: failed PR",
          );
          continue;
        }
        if (!result.action) continue;
        actions.push(result.action);
        if (result.action.reason === "superseded") superseded += 1;
        else stale += 1;
      }
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
  const dryRun = opts.dryRun ?? opts.applyDefault !== false;
  const ghClient = opts.ghClient ?? (createGhCliClient({ repoDir: opts.repoDir }) as GhClient);
  const gitClient = opts.gitClient ?? createGitCliClient({ repoDir: opts.repoDir });

  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) {
      opts.log?.info?.(
        { event: "sweeper.skip_tick", sweeper: "pr-orphan-sweeper" },
        "sweeper.skip_tick",
      );
      return;
    }
    inFlight = true;
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
    })
      .catch((error) => {
        opts.log?.warn?.({ err: String(error) }, "pr-orphan-sweeper tick failed");
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  if (typeof (timer as any).unref === "function") {
    (timer as any).unref();
  }

  return {
    stop: () => clearInterval(timer),
  };
}
