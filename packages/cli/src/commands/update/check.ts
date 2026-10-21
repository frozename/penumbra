import { isAbsolute } from "node:path";

import { type IdleProbe, probeIdle } from "./idle.js";
import { checkSelfSafety, type SelfSafety } from "./self-safety.js";
import {
  type DaemonHealth,
  type HeavyLockInfo,
  type RuntimeState,
  type ServiceManagerKind,
  type ServiceUnitState,
  type UpdateContext,
  UpdateError,
} from "./types.js";

const MAX_LOG_LINES = 40;

export type RunsFrom =
  | { status: "ok"; path: string }
  | { status: "unknown"; path: null }
  | { status: "mismatch"; path: string };

export interface RuntimeReport {
  serviceManager: ServiceManagerKind | null;
  managerReason: string | null;
  state: RuntimeState | null;
  runsFrom: RunsFrom;
  health: DaemonHealth;
  idle: IdleProbe;
}

export interface CheckReport {
  repo: string;
  branch: string | null;
  ref: string;
  current: string;
  target: string;
  upToDate: boolean;
  fastForward: boolean;
  newCommits: number;
  commits: string[];
  depsChanged: boolean;
  ci: string;
  trackedChanges: string[];
  runtime: RuntimeReport;
  heavyLock: HeavyLockInfo;
  bun: string;
  selfSafety: SelfSafety;
  blockers: string[];
  applyReady: boolean;
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

async function unitRunsFrom(ctx: UpdateContext, unit: ServiceUnitState): Promise<RunsFrom> {
  const script = unit.argv.find((arg) => isAbsolute(arg) && arg.endsWith(".ts"));
  const candidates = [unit.workingDirectory, script].filter(
    (path): path is string => typeof path === "string" && isAbsolute(path),
  );
  if (candidates.length === 0) return { status: "unknown", path: null };
  const repoReal = await ctx.fs.realpath(ctx.repo);
  for (const candidate of candidates) {
    const real = await ctx.fs.realpath(candidate).catch(() => candidate);
    if (isInside(repoReal, real) || isInside(ctx.repo, candidate)) {
      return { status: "ok", path: candidate };
    }
  }
  return { status: "mismatch", path: candidates[0] ?? "" };
}

/** Whether the daemon and worker run from the checkout being updated. */
export async function runsFromRepo(
  ctx: UpdateContext,
  state: RuntimeState | null,
): Promise<RunsFrom> {
  if (state === null) return { status: "unknown", path: null };
  const results = [await unitRunsFrom(ctx, state.daemon), await unitRunsFrom(ctx, state.worker)];
  return (
    results.find((r) => r.status === "mismatch") ??
    results.find((r) => r.status === "ok") ?? { status: "unknown", path: null }
  );
}

export async function gatherRuntime(ctx: UpdateContext): Promise<RuntimeReport> {
  const state = ctx.manager ? await ctx.manager.state() : null;
  return {
    serviceManager: ctx.manager?.kind ?? null,
    managerReason: ctx.managerReason,
    state,
    runsFrom: await runsFromRepo(ctx, state),
    health: await ctx.daemon.health(),
    idle: await probeIdle(ctx, { requireDaemon: false }),
  };
}

export function selfCommand(ctx: UpdateContext, modeFlag: string): string {
  return `${ctx.bunPath} ${ctx.repo}/packages/cli/bin/penumbra.ts update ${modeFlag}`;
}

export function noManagerInstructions(reason: string): string {
  return (
    `${reason}. Set PENUMBRA_UPDATE_DAEMON_UNIT / PENUMBRA_UPDATE_WORKER_UNIT ` +
    "(launchd: PENUMBRA_UPDATE_DAEMON_LABEL / PENUMBRA_UPDATE_WORKER_LABEL) or pass " +
    "--daemon-unit/--worker-unit, or update by hand: git merge --ff-only, " +
    "`bun install --frozen-lockfile` when bun.lock changed, then restart the daemon and worker"
  );
}

/** Gates shared by --apply and --rollback: what must hold before touching the checkout. */
export function runtimeBlockers(
  ctx: UpdateContext,
  input: {
    branch: string | null;
    trackedChanges: string[];
    runtime: RuntimeReport;
    selfSafety: SelfSafety;
  },
): string[] {
  const blockers: string[] = [];
  if (input.branch === null) {
    blockers.push(`HEAD is detached in ${ctx.repo}; check out a branch first`);
  }
  if (input.trackedChanges.length > 0) {
    const files = input.trackedChanges
      .slice(0, 5)
      .map((line) => line.trim())
      .join("; ");
    blockers.push(`tracked local changes in ${ctx.repo} (${files}); commit or discard them first`);
  }
  if (ctx.manager === null) {
    blockers.push(noManagerInstructions(ctx.managerReason ?? "no service manager"));
  }
  if (input.runtime.runsFrom.status === "mismatch") {
    blockers.push(
      `the service runs from ${input.runtime.runsFrom.path}, not from ${ctx.repo}; pass --repo <that checkout>`,
    );
  }
  if (!input.selfSafety.ok) blockers.push(input.selfSafety.reason);
  return blockers;
}

function applyOnlyBlockers(
  ctx: UpdateContext,
  report: Omit<CheckReport, "applyReady" | "blockers">,
): string[] {
  const blockers: string[] = [];
  if (!report.fastForward) {
    blockers.push(
      `${report.ref} (${report.target.slice(0, 12)}) is not a fast-forward of ${report.current.slice(0, 12)}; refusing (fast-forward only)`,
    );
  }
  if (report.ci !== "success" && !ctx.options.allowRedCi) {
    blockers.push(`target CI is '${report.ci}' (use --allow-red-ci to override)`);
  }
  if (!report.runtime.health.ok) {
    blockers.push(
      `daemon is not healthy (${report.runtime.health.detail}); fix it first or use --rollback`,
    );
  }
  return blockers;
}

/** Fetches, then describes current → target, the runtime and every --apply gate. */
export async function buildCheckReport(ctx: UpdateContext): Promise<CheckReport> {
  const branch = await ctx.git.branch();
  await ctx.git.fetch(ctx.options.ref);
  const current = await ctx.git.head();
  const target = await ctx.git.resolve(ctx.options.ref);
  if (target === null) throw new UpdateError(`unknown ref: ${ctx.options.ref}`);
  const upToDate = current === target;
  const fastForward = upToDate || (await ctx.git.isAncestor(current, target));
  const log =
    fastForward && !upToDate
      ? await ctx.git.log(current, target, MAX_LOG_LINES)
      : { count: 0, lines: [] };
  const runtime = await gatherRuntime(ctx);
  const selfSafety = await checkSelfSafety(
    ctx.host,
    ctx.manager,
    runtime.state,
    selfCommand(ctx, "--apply"),
  );
  const trackedChanges = await ctx.git.trackedChanges();
  const partial = {
    repo: ctx.repo,
    branch,
    ref: ctx.options.ref,
    current,
    target,
    upToDate,
    fastForward,
    newCommits: log.count,
    commits: log.lines,
    depsChanged: upToDate ? false : await ctx.git.depsChanged(current, target),
    ci: upToDate ? "n/a" : await ctx.ci.state(target),
    trackedChanges,
    runtime,
    heavyLock: ctx.heavyLock,
    bun: ctx.bunPath,
    selfSafety,
  };
  const blockers = upToDate
    ? []
    : [...runtimeBlockers(ctx, partial), ...applyOnlyBlockers(ctx, partial)];
  return { ...partial, blockers, applyReady: !upToDate && blockers.length === 0 };
}
