import { homedir } from "node:os";
import { join } from "node:path";

import { type MoveOutcome, runMove } from "./apply.js";
import {
  buildCheckReport,
  type CheckReport,
  gatherRuntime,
  runtimeBlockers,
  selfCommand,
} from "./check.js";
import { createDaemonPort, createLogReader } from "./daemon.js";
import {
  createDefaultHost,
  defaultClock,
  defaultExec,
  defaultFs,
  defaultHttp,
  defaultOnSignal,
} from "./deps.js";
import { checkReportJson, formatCheckReport } from "./format.js";
import { createCiPort, createGitPort } from "./git.js";
import { lastCompletedFrom } from "./history.js";
import { createInstallPort, resolveBunPath, resolveHeavyLock } from "./install.js";
import { parseUpdateArgs, UPDATE_USAGE } from "./options.js";
import { checkSelfSafety } from "./self-safety.js";
import { type ManagerSelection, selectServiceManager } from "./service-manager.js";
import {
  type CiPort,
  type Clock,
  type DaemonPort,
  type Exec,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  type FsPort,
  type GitPort,
  type HostPort,
  type Http,
  type InstallPort,
  type LogReader,
  type OnSignal,
  type UpdateContext,
  UpdateError,
  type UpdateOptions,
} from "./types.js";

export interface UpdateDeps {
  exec: Exec;
  http: Http;
  fs: FsPort;
  clock: Clock;
  host: HostPort;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  /** Directory of this CLI; its checkout is the default --repo. */
  cliDir: string;
  /** Fallback bun when the service's ExecStart does not name one. */
  bunPath: string;
  onSignal: OnSignal;
  exit: (code: number) => void;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Test seams: replace a port built from exec/http/fs. */
  ports?: Partial<{
    git: GitPort;
    ci: CiPort;
    daemon: DaemonPort;
    logs: LogReader;
    install: InstallPort;
    manager: ManagerSelection;
  }>;
}

export function defaultUpdateDeps(): UpdateDeps {
  return {
    exec: defaultExec,
    http: defaultHttp,
    fs: defaultFs,
    clock: defaultClock,
    host: createDefaultHost(defaultExec),
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    cliDir: import.meta.dir,
    bunPath: process.execPath,
    onSignal: defaultOnSignal,
    exit: (code) => process.exit(code),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

async function selectManager(options: UpdateOptions, deps: UpdateDeps): Promise<ManagerSelection> {
  if (deps.ports?.manager) return deps.ports.manager;
  return await selectServiceManager({
    choice: options.serviceManager,
    platform: deps.host.platform,
    exec: deps.exec,
    uid: deps.host.uid,
    home: deps.home,
    names: options,
  });
}

export async function createUpdateContext(
  options: UpdateOptions,
  storageRoot: string,
  deps: UpdateDeps,
): Promise<UpdateContext> {
  const repo = await (
    deps.ports?.git ?? createGitPort(deps.exec, options.repo ?? deps.cliDir)
  ).topLevel();
  const selection = await selectManager(options, deps);
  const state = selection.manager ? await selection.manager.state().catch(() => null) : null;
  const heavyLock = resolveHeavyLock(deps.env, state, deps.home);
  const bunPath = resolveBunPath(state, deps.bunPath);
  const say = options.json ? deps.err : deps.out;
  return {
    options,
    storageRoot,
    repo,
    historyPath: join(storageRoot, "update-history.log"),
    git: deps.ports?.git ?? createGitPort(deps.exec, repo),
    ci: deps.ports?.ci ?? createCiPort(deps.exec, repo),
    daemon: deps.ports?.daemon ?? createDaemonPort(storageRoot, deps.fs, deps.http),
    host: deps.host,
    fs: deps.fs,
    logs: deps.ports?.logs ?? createLogReader(deps.fs, deps.exec, deps.clock),
    install:
      deps.ports?.install ??
      createInstallPort({ exec: deps.exec, bunPath, env: deps.env, heavyLock }),
    clock: deps.clock,
    manager: selection.manager,
    managerReason: selection.reason,
    heavyLock,
    bunPath,
    env: deps.env,
    home: deps.home,
    onSignal: deps.onSignal,
    exit: deps.exit,
    say,
  };
}

function emitOutcome(
  ctx: UpdateContext,
  deps: UpdateDeps,
  mode: string,
  outcome: MoveOutcome,
): number {
  if (ctx.options.json) {
    deps.out(JSON.stringify({ mode, ...outcome }));
    return outcome.exitCode;
  }
  for (const note of outcome.notes) deps.out(`  ${note}`);
  const from = outcome.from.slice(0, 12);
  const to = outcome.to.slice(0, 12);
  const messages: Record<MoveOutcome["outcome"], string> = {
    updated: `done: ${from} -> ${to}. Roll back with: penumbra update --rollback ${from}`,
    refused: `nothing changed: ${outcome.failure?.detail ?? "refused"}`,
    "rolled-back": `update to ${to} failed (${outcome.failure?.detail ?? "?"}); rolled back to ${from}`,
    "needs-operator": `runtime needs attention. Failed: ${outcome.failure?.detail ?? "?"}. Recovery: ${outcome.recovery?.failure?.detail ?? "none"}. Inspect the daemon/worker units, git -C ${ctx.repo} log and ${ctx.historyPath}`,
  };
  (outcome.exitCode === EXIT_OK ? deps.out : deps.err)(
    `penumbra update: ${messages[outcome.outcome]}`,
  );
  return outcome.exitCode;
}

function refuse(
  ctx: UpdateContext,
  deps: UpdateDeps,
  blockers: string[],
  extra: Record<string, unknown>,
): number {
  if (ctx.options.json) {
    deps.out(JSON.stringify({ outcome: "refused", blockers, ...extra }));
  } else {
    deps.err("penumbra update: refusing:");
    for (const blocker of blockers) deps.err(`  - ${blocker}`);
  }
  return EXIT_REFUSED;
}

function printReport(ctx: UpdateContext, deps: UpdateDeps, report: CheckReport): void {
  if (ctx.options.json && ctx.options.mode === "check") {
    deps.out(JSON.stringify({ mode: "check", ...checkReportJson(report) }));
    return;
  }
  for (const line of formatCheckReport(report)) ctx.say(line);
}

async function runCheckOrApply(ctx: UpdateContext, deps: UpdateDeps): Promise<number> {
  const report = await buildCheckReport(ctx);
  printReport(ctx, deps, report);
  if (ctx.options.mode === "check") {
    if (!ctx.options.json && !report.upToDate) {
      ctx.say("check only; run `penumbra update --apply` to update");
    }
    return EXIT_OK;
  }
  if (report.upToDate) {
    if (ctx.options.json) {
      deps.out(JSON.stringify({ mode: "apply", outcome: "up-to-date", sha: report.current }));
    }
    return EXIT_OK;
  }
  if (!report.applyReady || ctx.manager === null) {
    return refuse(ctx, deps, report.blockers, {
      mode: "apply",
      from: report.current,
      to: report.target,
    });
  }
  const outcome = await runMove(ctx, ctx.manager, {
    mode: "apply",
    from: report.current,
    to: report.target,
    depsChanged: report.depsChanged,
  });
  return emitOutcome(ctx, deps, "apply", outcome);
}

async function rollbackTarget(ctx: UpdateContext): Promise<string> {
  const wanted =
    ctx.options.rollbackSha ?? lastCompletedFrom((await ctx.fs.readText(ctx.historyPath)) ?? "");
  if (wanted === null) {
    throw new UpdateError(`no rollback target in ${ctx.historyPath}; pass a sha`);
  }
  const sha = await ctx.git.resolve(wanted);
  if (sha === null) {
    throw new UpdateError(`rollback target ${wanted} is not a commit in ${ctx.repo}`);
  }
  return sha;
}

/** reset --hard must neither land off the tracked ref nor drop local commits. */
async function refBlockers(ctx: UpdateContext, from: string, to: string): Promise<string[]> {
  const ref = ctx.options.ref;
  const blockers: string[] = [];
  if (!(await ctx.git.isAncestor(to, ref))) {
    blockers.push(`${to.slice(0, 12)} is not on ${ref}; refusing to reset the checkout to it`);
  }
  if (!(await ctx.git.isAncestor(from, ref))) {
    blockers.push(
      `HEAD ${from.slice(0, 12)} has commits that are not on ${ref}; push or move them before rolling back`,
    );
  }
  return blockers;
}

async function runRollback(ctx: UpdateContext, deps: UpdateDeps): Promise<number> {
  const branch = await ctx.git.branch();
  try {
    await ctx.git.fetch(ctx.options.ref);
  } catch (err) {
    ctx.say(
      `warning: ${err instanceof Error ? err.message : String(err)}; using the local ${ctx.options.ref}`,
    );
  }
  const from = await ctx.git.head();
  const to = await rollbackTarget(ctx);
  ctx.say(`penumbra update: rolling back ${from.slice(0, 12)} -> ${to.slice(0, 12)}`);
  if (from === to) {
    return refuse(ctx, deps, [`already at ${to.slice(0, 12)}; pass the sha to roll back to`], {
      mode: "rollback",
      from,
      to,
    });
  }
  const runtime = await gatherRuntime(ctx);
  const selfSafety = await checkSelfSafety(
    ctx.host,
    ctx.manager,
    runtime.state,
    selfCommand(ctx, "--rollback"),
  );
  const blockers = runtimeBlockers(ctx, {
    branch,
    trackedChanges: await ctx.git.trackedChanges(),
    runtime,
    selfSafety,
  });
  blockers.push(...(await refBlockers(ctx, from, to)));
  if (blockers.length > 0 || ctx.manager === null) {
    return refuse(ctx, deps, blockers, { mode: "rollback", from, to });
  }
  const outcome = await runMove(ctx, ctx.manager, {
    mode: "rollback",
    from,
    to,
    depsChanged: await ctx.git.depsChanged(from, to),
  });
  return emitOutcome(ctx, deps, "rollback", outcome);
}

/** `penumbra update` entry point; returns the process exit code. */
export async function runUpdateCommand(
  args: string[],
  storageRoot: string,
  deps: UpdateDeps = defaultUpdateDeps(),
): Promise<number> {
  const parsed = parseUpdateArgs(args, deps.env, deps.cwd);
  if (parsed.ok === "help") {
    deps.out(UPDATE_USAGE);
    return EXIT_OK;
  }
  if (!parsed.ok) {
    deps.err(`penumbra update: ${parsed.error}`);
    deps.err(UPDATE_USAGE);
    return EXIT_USAGE;
  }
  try {
    const ctx = await createUpdateContext(parsed.options, storageRoot, deps);
    return parsed.options.mode === "rollback"
      ? await runRollback(ctx, deps)
      : await runCheckOrApply(ctx, deps);
  } catch (err) {
    deps.err(`penumbra update: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_REFUSED;
  }
}
