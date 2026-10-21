import { appendHistory } from "./history.js";
import { waitForIdle } from "./idle.js";
import {
  EXIT_NEEDS_OPERATOR,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_ROLLED_BACK,
  type ServiceManager,
  type UpdateContext,
} from "./types.js";
import { type LogWatch, verifyRuntime, watchLogs } from "./verify.js";

export type Step =
  | { kind: "freeze" }
  | { kind: "install" }
  | { kind: "move"; how: "fast-forward" | "reset"; to: string }
  | { kind: "record"; entry: string }
  | { kind: "restart" }
  | { kind: "unfreeze" }
  | { kind: "verify"; expect: string; restarted: "both" | "worker" }
  | { kind: "wait-idle"; requireDaemon: boolean };

export interface MoveState {
  frozen: boolean;
  installRan: boolean;
  restartAttempted: boolean;
  watch: LogWatch | null;
  completed: string[];
  notes: string[];
}

export type StepsResult = { ok: true } | { ok: false; step: Step; detail: string };

export interface MoveOutcome {
  outcome: "refused" | "rollback-failed" | "rolled-back" | "updated";
  exitCode: number;
  from: string;
  to: string;
  completed: string[];
  failure: { step: string; detail: string } | null;
  recovery: { completed: string[]; failure: { step: string; detail: string } | null } | null;
  notes: string[];
}

export function stepLabel(step: Step): string {
  switch (step.kind) {
    case "move":
      return `${step.how} ${step.to.slice(0, 12)}`;
    case "record":
      return `record "${step.entry}"`;
    case "verify":
      return `verify ${step.expect.slice(0, 12)}`;
    case "freeze":
    case "install":
    case "restart":
    case "unfreeze":
    case "wait-idle":
      return step.kind;
  }
}

/**
 * The ordered procedure for one move of the checkout. With a freezable worker
 * (systemd) the worker is stopped once idle, so it cannot claim work while the
 * checkout and node_modules change under it; otherwise idleness is re-checked
 * just before the restart.
 */
export function planMove(input: {
  mode: "apply" | "rollback";
  from: string;
  to: string;
  depsChanged: boolean;
  canFreeze: boolean;
}): Step[] {
  const requireDaemon = input.mode === "apply";
  const steps: Step[] = [{ kind: "wait-idle", requireDaemon }];
  if (input.canFreeze) steps.push({ kind: "freeze" });
  steps.push(
    { kind: "record", entry: `${input.mode} from=${input.from} to=${input.to}` },
    { kind: "move", how: input.mode === "apply" ? "fast-forward" : "reset", to: input.to },
  );
  if (input.depsChanged) steps.push({ kind: "install" });
  if (!input.canFreeze) steps.push({ kind: "wait-idle", requireDaemon });
  steps.push({ kind: "restart" }, { kind: "verify", expect: input.to, restarted: "both" });
  return steps;
}

/** Steps that put the runtime back on `good` after a failed move, given how far it got. */
export function planRecovery(input: {
  good: string;
  head: string;
  state: Pick<MoveState, "frozen" | "installRan" | "restartAttempted">;
  canFreeze: boolean;
}): Step[] {
  const { state } = input;
  const steps: Step[] = [];
  if (input.canFreeze && state.restartAttempted && !state.frozen) steps.push({ kind: "freeze" });
  if (input.head !== input.good) steps.push({ kind: "move", how: "reset", to: input.good });
  if (state.installRan) steps.push({ kind: "install" });
  if (state.restartAttempted || input.head !== input.good || state.installRan) {
    steps.push({ kind: "restart" }, { kind: "verify", expect: input.good, restarted: "both" });
  } else if (state.frozen) {
    steps.push({ kind: "unfreeze" }, { kind: "verify", expect: input.good, restarted: "worker" });
  }
  return steps;
}

export function newMoveState(): MoveState {
  return {
    frozen: false,
    installRan: false,
    restartAttempted: false,
    watch: null,
    completed: [],
    notes: [],
  };
}

async function runVerify(
  ctx: UpdateContext,
  manager: ServiceManager,
  step: Extract<Step, { kind: "verify" }>,
  state: MoveState,
): Promise<string | null> {
  const watch = state.watch ?? (await watchLogs(ctx, manager));
  const scoped: LogWatch =
    step.restarted === "worker"
      ? {
          ...watch,
          daemon: { ...watch.daemon, source: { kind: "none", reason: "daemon not restarted" } },
        }
      : watch;
  const res = await verifyRuntime(ctx, manager, scoped, step.expect);
  state.notes.push(...res.notes);
  return res.ok ? null : res.detail;
}

async function runInstall(ctx: UpdateContext, state: MoveState): Promise<string | null> {
  ctx.say("bun install --frozen-lockfile (memory-capped, under the heavy-job lock)");
  const res = await ctx.install.install(ctx.repo);
  state.installRan ||= res.ran;
  return res.ok ? null : `bun install failed: ${res.detail}`;
}

async function runIdle(ctx: UpdateContext, requireDaemon: boolean): Promise<string | null> {
  const res = await waitForIdle(ctx, { budgetS: ctx.options.waitIdleS, requireDaemon });
  if (res.ok) return null;
  return `still busy after ${String(ctx.options.waitIdleS)}s (${res.reasons.join("; ")}); retry later or raise --wait-idle`;
}

async function runServiceStep(
  ctx: UpdateContext,
  manager: ServiceManager,
  kind: "freeze" | "restart" | "unfreeze",
  state: MoveState,
): Promise<null> {
  if (kind === "freeze") {
    await manager.freeze();
    state.frozen = true;
    ctx.say(`stopped ${manager.workerName} so it claims no new work during the update`);
    return null;
  }
  state.watch = await watchLogs(ctx, manager);
  if (kind === "unfreeze") {
    await manager.unfreeze();
  } else {
    state.restartAttempted = true;
    await manager.restart();
  }
  state.frozen = false;
  return null;
}

async function runStep(
  ctx: UpdateContext,
  manager: ServiceManager,
  step: Step,
  state: MoveState,
): Promise<string | null> {
  switch (step.kind) {
    case "wait-idle":
      return await runIdle(ctx, step.requireDaemon);
    case "record":
      await appendHistory(ctx.fs, ctx.clock, ctx.historyPath, step.entry);
      return null;
    case "move":
      await (step.how === "fast-forward"
        ? ctx.git.fastForward(step.to)
        : ctx.git.resetHard(step.to));
      return null;
    case "install":
      return await runInstall(ctx, state);
    case "verify":
      return await runVerify(ctx, manager, step, state);
    case "freeze":
    case "restart":
    case "unfreeze":
      return await runServiceStep(ctx, manager, step.kind, state);
  }
}

export async function runSteps(
  ctx: UpdateContext,
  manager: ServiceManager,
  steps: Step[],
  state: MoveState,
): Promise<StepsResult> {
  for (const step of steps) {
    ctx.say(`→ ${stepLabel(step)}`);
    let detail: string | null;
    try {
      detail = await runStep(ctx, manager, step, state);
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    if (detail !== null) return { ok: false, step, detail };
    state.completed.push(stepLabel(step));
  }
  return { ok: true };
}

function failureOf(result: StepsResult): { step: string; detail: string } | null {
  return result.ok ? null : { step: stepLabel(result.step), detail: result.detail };
}

async function currentHead(ctx: UpdateContext, fallback: string): Promise<string> {
  try {
    return await ctx.git.head();
  } catch {
    return fallback;
  }
}

interface MoveRequest {
  mode: "apply" | "rollback";
  from: string;
  to: string;
  depsChanged: boolean;
}

async function recover(
  ctx: UpdateContext,
  manager: ServiceManager,
  req: MoveRequest,
  state: MoveState,
  failed: StepsResult,
): Promise<MoveOutcome> {
  const head = await currentHead(ctx, req.to);
  const changed = head !== req.from || state.installRan || state.restartAttempted;
  const base = {
    from: req.from,
    to: req.to,
    completed: [...state.completed],
    failure: failureOf(failed),
  };
  if (req.mode === "rollback" && changed) {
    await appendHistory(ctx.fs, ctx.clock, ctx.historyPath, `rollback-failed to=${req.to}`);
    return {
      ...base,
      outcome: "rollback-failed",
      exitCode: EXIT_NEEDS_OPERATOR,
      recovery: null,
      notes: state.notes,
    };
  }
  const steps = planRecovery({ good: req.from, head, state, canFreeze: manager.canFreeze });
  if (steps.length > 0) {
    ctx.say(changed ? `rolling back to ${req.from.slice(0, 12)}` : "restoring the worker");
  }
  const recoveryState = { ...newMoveState(), frozen: state.frozen };
  const result = await runSteps(ctx, manager, steps, recoveryState);
  const recovery = { completed: recoveryState.completed, failure: failureOf(result) };
  const notes = [...state.notes, ...recoveryState.notes];
  if (!result.ok) {
    await appendHistory(ctx.fs, ctx.clock, ctx.historyPath, `rollback-failed to=${req.from}`);
    return { ...base, outcome: "rollback-failed", exitCode: EXIT_NEEDS_OPERATOR, recovery, notes };
  }
  if (!changed) return { ...base, outcome: "refused", exitCode: EXIT_REFUSED, recovery, notes };
  await appendHistory(ctx.fs, ctx.clock, ctx.historyPath, `rolled-back to=${req.from}`);
  return { ...base, outcome: "rolled-back", exitCode: EXIT_ROLLED_BACK, recovery, notes };
}

/** Runs one move (apply or rollback); a failed apply is rolled back automatically. */
export async function runMove(
  ctx: UpdateContext,
  manager: ServiceManager,
  req: MoveRequest,
): Promise<MoveOutcome> {
  const steps = planMove({ ...req, canFreeze: manager.canFreeze });
  const state = newMoveState();
  const result = await runSteps(ctx, manager, steps, state);
  if (result.ok) {
    await appendHistory(ctx.fs, ctx.clock, ctx.historyPath, `ok ${req.to}`);
    return {
      outcome: "updated",
      exitCode: EXIT_OK,
      from: req.from,
      to: req.to,
      completed: state.completed,
      failure: null,
      recovery: null,
      notes: state.notes,
    };
  }
  ctx.say(`FAILED at ${stepLabel(result.step)}: ${result.detail}`);
  return await recover(ctx, manager, req, state, result);
}
