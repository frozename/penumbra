import type { Database } from "bun:sqlite";

import { spawn } from "node:child_process";

import { HandoffReader } from "../../../core/src/readers/handoff.js";
import { isAncestorOf, isThreeDotDiffEmpty } from "../../../core/src/worktree/branch-land-probe.js";
import {
  type GhClient as CanonicalGhClient,
  createGhCliClient,
  type GhOpenPullRequest,
} from "../services/gh-client.js";

const AGENT_HEAD_RE = /^agent\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7;
const MIN_AGE_DAYS = 1;
const DEFAULT_INTERVAL_MS = 21_600_000; // 6h
const SWEEP_BATCH_SIZE = 6;

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

export type SweepReason = "superseded" | "stale" | "stale_unlanded";
export type SweepActionKind =
  | "closed_and_deleted"
  | "closed"
  | "labeled_stale_unlanded"
  | "dry_run_superseded"
  | "dry_run_stale"
  | "dry_run_stale_unlanded";

export const STALE_UNLANDED_LABEL = "stale-unlanded";

export type OpenPullRequest = GhOpenPullRequest;
export type GhClient = Required<
  Pick<CanonicalGhClient, "listOpenPullRequests" | "closePullRequest">
> &
  Pick<CanonicalGhClient, "labelPullRequest">;

export interface GitClient {
  resolveMainSha(): Promise<string>;
  isAncestorOfMain(headSha: string): Promise<boolean>;
  isObjectReachable(headSha: string): Promise<boolean>;
  fetchHeadRef(headRef: string): Promise<void>;
  isThreeDotDiffEmptyVsMain(headSha: string): Promise<boolean>;
}

export interface SweeperEventWriter {
  write(row: unknown): void;
}

export interface FleetBranchReader {
  findByBranchName(name: string): unknown | null;
}

export interface PrOrphanSweeperDeps {
  ghClient: GhClient;
  gitClient: GitClient;
  handoffReader?: FleetBranchReader;
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
  stale_unlanded: number;
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

type PrRowResult =
  | { row: OpenPullRequest; action: PrSweepAction | null; error: null }
  | { row: OpenPullRequest; action: null; error: unknown };

interface PrSweepCounters {
  superseded: number;
  stale: number;
  stale_unlanded: number;
}

interface PrSweepContext {
  deps: PrOrphanSweeperDeps;
  mainSha: string;
  nowIso: string;
  nowMs: number;
  actions: PrSweepAction[];
  counters: PrSweepCounters;
}

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function run(file: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Uint8Array | string) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Uint8Array | string) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// Adapter that converts the local spawn-based `run` (which never throws on a
// non-zero exit) into the throw-on-fail runner shape the shared core probes
// expect. Errors carry `.code` and `.stderr` so the helpers can decode the
// exit-code-1 ancestor-miss as a clean `false`.
function makeThrowingGitRunner(
  repoDir: string,
): (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }> {
  return async (cmd, args, opts) => {
    const res = await run(cmd, args, opts?.cwd ?? repoDir);
    if (res.code !== 0) {
      const err = new Error(
        `${cmd} ${args.join(" ")} exited with code ${String(res.code)}`,
      ) as Error & { code: number | string | null; stderr: string };
      err.code = res.code;
      err.stderr = res.stderr;
      throw err;
    }
    return { stdout: res.stdout, stderr: res.stderr };
  };
}

export function createGitCliClient(opts: { repoDir?: string } = {}): GitClient {
  const repoDir = opts.repoDir ?? process.cwd();
  const throwingRunner = makeThrowingGitRunner(repoDir);
  return {
    async resolveMainSha(): Promise<string> {
      const res = await run("git", ["rev-parse", "main"], repoDir);
      if (res.code !== 0) {
        throw new Error(
          `git rev-parse main failed (${String(res.code)}): ${res.stderr.slice(0, 500)}`,
        );
      }
      return res.stdout.trim();
    },

    isAncestorOfMain(headSha: string): Promise<boolean> {
      return isAncestorOf(throwingRunner, repoDir, headSha, "main");
    },

    async isObjectReachable(headSha: string): Promise<boolean> {
      const res = await run("git", ["cat-file", "-e", `${headSha}^{commit}`], repoDir);
      if (res.code === 0) return true;
      if (res.code === 1 || res.code === 128) return false;
      throw new Error(`git cat-file -e failed (${String(res.code)}): ${res.stderr.slice(0, 500)}`);
    },

    async fetchHeadRef(headRef: string): Promise<void> {
      const res = await run("git", ["fetch", "origin", headRef], repoDir);
      if (res.code !== 0) {
        throw new Error(
          `git fetch origin ${headRef} failed (${String(res.code)}): ${res.stderr.slice(0, 500)}`,
        );
      }
    },

    isThreeDotDiffEmptyVsMain(headSha: string): Promise<boolean> {
      return isThreeDotDiffEmpty(throwingRunner, repoDir, headSha, "main");
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
    payload_summary: `pr #${String(action.pr_number)} ${action.reason} ${action.action}`,
  });
}

async function maybeCloseAncestorPr(args: {
  deps: PrOrphanSweeperDeps;
  row: OpenPullRequest;
  mainSha: string;
  nowIso: string;
  days: number;
}): Promise<PrSweepAction | null> {
  const isAncestor = await args.deps.gitClient.isAncestorOfMain(args.row.headRefOid);
  if (!isAncestor) return null;

  const comment = `Superseded: head commit ${args.row.headRefOid} is reachable from main as ${args.mainSha}. Closing.`;
  const action: PrSweepAction = {
    pr_number: args.row.number,
    action: args.deps.dryRun ? "dry_run_superseded" : "closed_and_deleted",
    reason: "superseded",
    comment,
    head_ref: args.row.headRefName,
    head_sha: args.row.headRefOid,
    age_days: args.days,
    main_sha: args.mainSha,
  };
  if (!args.deps.dryRun) {
    await args.deps.ghClient.closePullRequest({
      number: args.row.number,
      comment,
      deleteBranch: true,
    });
  }
  emitSweepEvent(args.deps, args.nowIso, action);
  return action;
}

async function maybeCloseEmptyDiffPr(args: {
  deps: PrOrphanSweeperDeps;
  row: OpenPullRequest;
  mainSha: string;
  nowIso: string;
  days: number;
}): Promise<PrSweepAction | null> {
  const hasHeadObject = await args.deps.gitClient.isObjectReachable(args.row.headRefOid);
  if (!hasHeadObject) {
    await args.deps.gitClient.fetchHeadRef(args.row.headRefName);
  }
  const isDiffEmpty = await args.deps.gitClient.isThreeDotDiffEmptyVsMain(args.row.headRefOid);
  if (!isDiffEmpty) return null;

  const comment = `Superseded: head commit ${args.row.headRefOid} diff vs main is empty (work landed via rebase/cherry-pick). Closing.`;
  const action: PrSweepAction = {
    pr_number: args.row.number,
    action: args.deps.dryRun ? "dry_run_superseded" : "closed_and_deleted",
    reason: "superseded",
    comment,
    head_ref: args.row.headRefName,
    head_sha: args.row.headRefOid,
    age_days: args.days,
    main_sha: args.mainSha,
  };
  if (!args.deps.dryRun) {
    await args.deps.ghClient.closePullRequest({
      number: args.row.number,
      comment,
      deleteBranch: true,
    });
  }
  emitSweepEvent(args.deps, args.nowIso, action);
  return action;
}

async function probeStalePrIsLanded(
  deps: PrOrphanSweeperDeps,
  row: OpenPullRequest,
): Promise<boolean> {
  if (await deps.gitClient.isAncestorOfMain(row.headRefOid)) return true;
  const hasHeadObject = await deps.gitClient.isObjectReachable(row.headRefOid);
  if (!hasHeadObject) {
    await deps.gitClient.fetchHeadRef(row.headRefName);
  }
  return await deps.gitClient.isThreeDotDiffEmptyVsMain(row.headRefOid);
}

async function applyStaleUnlandedLabel(
  deps: PrOrphanSweeperDeps,
  row: OpenPullRequest,
  comment: string,
): Promise<void> {
  if (deps.ghClient.labelPullRequest === undefined) {
    deps.log?.warn?.(
      { pr_number: row.number, head_ref: row.headRefName },
      "pr-orphan-sweeper: cannot label stale-unlanded PR (gh client lacks labelPullRequest)",
    );
    return;
  }
  await deps.ghClient.labelPullRequest({
    number: row.number,
    labels: [STALE_UNLANDED_LABEL],
    comment,
  });
}

async function maybeCloseStalePr(args: {
  deps: PrOrphanSweeperDeps;
  row: OpenPullRequest;
  nowIso: string;
  days: number;
}): Promise<PrSweepAction | null> {
  if (args.days <= STALE_DAYS) return null;

  // Only auto-close stale PRs whose work has actually landed (ancestor of main
  // or empty three-dot diff). An unlanded stale PR may still hold the only
  // copy of in-progress work — downgrade to a label so a human can decide.
  let landed: boolean;
  try {
    landed = await probeStalePrIsLanded(args.deps, args.row);
  } catch (err) {
    args.deps.log?.warn?.(
      {
        err: formatUnknownError(err),
        pr_number: args.row.number,
        head_ref: args.row.headRefName,
      },
      "pr-orphan-sweeper: stale-PR land probe failed; treating as unlanded",
    );
    landed = false;
  }

  if (!landed) {
    const comment = `Stale-unlanded: no activity for ${String(args.days)} days and head commit ${args.row.headRefOid} is not in main. Labeling for human review.`;
    const action: PrSweepAction = {
      pr_number: args.row.number,
      action: args.deps.dryRun ? "dry_run_stale_unlanded" : "labeled_stale_unlanded",
      reason: "stale_unlanded",
      comment,
      head_ref: args.row.headRefName,
      head_sha: args.row.headRefOid,
      age_days: args.days,
    };
    if (!args.deps.dryRun) {
      try {
        await applyStaleUnlandedLabel(args.deps, args.row, comment);
      } catch (err) {
        args.deps.log?.warn?.(
          {
            err: formatUnknownError(err),
            pr_number: args.row.number,
            head_ref: args.row.headRefName,
          },
          "pr-orphan-sweeper: failed to apply stale-unlanded label",
        );
      }
    }
    emitSweepEvent(args.deps, args.nowIso, action);
    return action;
  }

  const comment = `Stale: no activity for ${String(args.days)} days; closing as abandoned. Reopen if needed.`;
  const action: PrSweepAction = {
    pr_number: args.row.number,
    action: args.deps.dryRun ? "dry_run_stale" : "closed",
    reason: "stale",
    comment,
    head_ref: args.row.headRefName,
    head_sha: args.row.headRefOid,
    age_days: args.days,
  };
  if (!args.deps.dryRun) {
    await args.deps.ghClient.closePullRequest({
      number: args.row.number,
      comment,
      deleteBranch: false,
    });
  }
  emitSweepEvent(args.deps, args.nowIso, action);
  return action;
}

async function processPrRow(args: {
  deps: PrOrphanSweeperDeps;
  row: OpenPullRequest;
  mainSha: string;
  nowIso: string;
  nowMs: number;
}): Promise<PrSweepAction | null> {
  const days = ageDays(args.nowMs, args.row.updatedAt);
  if (days < MIN_AGE_DAYS) return null;

  const baseArgs = {
    deps: args.deps,
    row: args.row,
    mainSha: args.mainSha,
    nowIso: args.nowIso,
    days,
  };
  return (
    (await maybeCloseAncestorPr(baseArgs)) ??
    (await maybeCloseEmptyDiffPr(baseArgs)) ??
    (await maybeCloseStalePr({ deps: args.deps, row: args.row, nowIso: args.nowIso, days }))
  );
}

function countAction(counters: PrSweepCounters, action: PrSweepAction): void {
  if (action.reason === "superseded") counters.superseded += 1;
  else if (action.reason === "stale_unlanded") counters.stale_unlanded += 1;
  else counters.stale += 1;
}

function recordPrAction(ctx: PrSweepContext, action: PrSweepAction | null): void {
  if (!action) return;
  ctx.actions.push(action);
  countAction(ctx.counters, action);
}

function logPrRowError(deps: PrOrphanSweeperDeps, row: OpenPullRequest, error: unknown): void {
  deps.log?.warn?.(
    { err: formatUnknownError(error), pr_number: row.number, head_ref: row.headRefName },
    "pr-orphan-sweeper: failed PR",
  );
}

async function processPrRowsBounded(
  ctx: PrSweepContext,
  prs: OpenPullRequest[],
  maxClose: number,
): Promise<number> {
  let errored = 0;
  for (const row of prs) {
    try {
      const action = await processPrRow({ ...ctx, row });
      recordPrAction(ctx, action);
      if (ctx.actions.length >= maxClose) break;
    } catch (error) {
      errored += 1;
      logPrRowError(ctx.deps, row, error);
    }
  }
  return errored;
}

async function processPrRowResult(ctx: PrSweepContext, row: OpenPullRequest): Promise<PrRowResult> {
  try {
    return {
      row,
      action: await processPrRow({ ...ctx, row }),
      error: null,
    } satisfies PrRowResult;
  } catch (error) {
    return { row, action: null, error } satisfies PrRowResult;
  }
}

function recordPrRowResults(ctx: PrSweepContext, results: PrRowResult[]): number {
  let errored = 0;
  for (const result of results) {
    if (result.error) {
      errored += 1;
      logPrRowError(ctx.deps, result.row, result.error);
      continue;
    }
    recordPrAction(ctx, result.action);
  }
  return errored;
}

function isFleetBranch(headRefName: string, handoffReader?: FleetBranchReader): boolean {
  if (handoffReader !== undefined && handoffReader.findByBranchName(headRefName) !== null) {
    return true;
  }
  return AGENT_HEAD_RE.test(headRefName);
}

async function processPrRowsBatched(ctx: PrSweepContext, prs: OpenPullRequest[]): Promise<number> {
  let errored = 0;
  for (let i = 0; i < prs.length; i += SWEEP_BATCH_SIZE) {
    const batch = prs.slice(i, i + SWEEP_BATCH_SIZE);
    const results = await Promise.all(batch.map(async (row) => await processPrRowResult(ctx, row)));
    errored += recordPrRowResults(ctx, results);
  }
  return errored;
}

export async function runPrOrphanSweep(deps: PrOrphanSweeperDeps): Promise<PrSweepResult> {
  const now = deps.clock();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const mainSha = await deps.gitClient.resolveMainSha();

  const actions: PrSweepAction[] = [];
  let scanned = 0;
  const prs = (await deps.ghClient.listOpenPullRequests()).filter((row) =>
    isFleetBranch(row.headRefName, deps.handoffReader),
  );
  scanned = prs.length;

  const counters: PrSweepCounters = { superseded: 0, stale: 0, stale_unlanded: 0 };
  const ctx: PrSweepContext = { deps, mainSha, nowIso, nowMs, actions, counters };
  const errored =
    deps.maxClose === undefined
      ? await processPrRowsBatched(ctx, prs)
      : await processPrRowsBounded(ctx, prs, deps.maxClose);
  const { superseded, stale, stale_unlanded } = counters;

  deps.log?.info?.(
    { scanned, superseded, stale, stale_unlanded, errored, dry_run: deps.dryRun },
    `pr-orphan-sweeper: scanned ${String(scanned)}, superseded ${String(superseded)}, stale ${String(stale)}, stale_unlanded ${String(stale_unlanded)}, errored ${String(errored)}`,
  );

  return { scanned, superseded, stale, stale_unlanded, errored, actions };
}

export function installPrOrphanSweeper(opts: InstallPrOrphanSweeperOpts): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const dryRun = opts.dryRun ?? opts.applyDefault !== false;
  const ghClient = opts.ghClient ?? (createGhCliClient({ repoDir: opts.repoDir }) as GhClient);
  const gitClient = opts.gitClient ?? createGitCliClient({ repoDir: opts.repoDir });
  const handoffReader = new HandoffReader({ db: opts.db });

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
      handoffReader,
      t0Writer: opts.t0Writer,
      uuid: opts.uuid,
      clock: opts.clock,
      machineId: opts.machineId,
      dryRun,
      maxClose: opts.maxClose,
      log: opts.log,
      projectId: opts.projectId,
    })
      .catch((error: unknown) => {
        opts.log?.warn?.({ err: formatUnknownError(error) }, "pr-orphan-sweeper tick failed");
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  maybeUnref(timer);

  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
}
