import { appendHistory } from "./history.js";
import { planMove, planRecovery, type Progress, type RecoveryPlan } from "./plan.js";
import {
  type MoveState,
  newMoveState,
  releaseLease,
  runSteps,
  type StepEnv,
  type StepsResult,
} from "./steps.js";
import {
  EXIT_NEEDS_OPERATOR,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_ROLLED_BACK,
  type ServiceManager,
  type UpdateContext,
} from "./types.js";

export interface MoveRequest {
  mode: "apply" | "rollback";
  from: string;
  to: string;
  depsChanged: boolean;
}

type Failure = { step: string; detail: string } | null;

export interface MoveOutcome {
  outcome: "needs-operator" | "refused" | "rolled-back" | "updated";
  exitCode: number;
  from: string;
  to: string;
  completed: string[];
  failure: Failure;
  recovery: { completed: string[]; failure: Failure } | null;
  notes: string[];
  /** Idle agent sessions the last passing idle probe let through: "<pid> <program>". */
  ignored_sessions: string[];
}

type MoveOutcomeWithoutSessions = Omit<MoveOutcome, "ignored_sessions">;

function short(sha: string): string {
  return sha.slice(0, 12);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failureOf(result: StepsResult): Failure {
  return result.ok ? null : { step: result.step, detail: result.detail };
}

/** Closing history lines never change the outcome; a write failure becomes a note. */
async function closeHistory(ctx: UpdateContext, state: MoveState, entry: string): Promise<void> {
  try {
    await appendHistory(ctx.fs, ctx.clock, ctx.historyPath, entry);
  } catch (err) {
    state.notes.push(`WARNING could not append "${entry}" to ${ctx.historyPath}: ${message(err)}`);
  }
}

async function headOr(ctx: UpdateContext, fallback: string): Promise<string> {
  try {
    return await ctx.git.head();
  } catch {
    return fallback;
  }
}

/** Invariant: the command never exits with the worker it stopped still stopped. */
async function ensureWorkerRunning(env: StepEnv): Promise<void> {
  if (!env.state.frozen) return;
  try {
    await env.manager.unfreeze();
    env.state.frozen = false;
    env.state.notes.push(`started ${env.manager.workerName} again`);
  } catch (err) {
    env.state.notes.push(
      `WARNING could not start ${env.manager.workerName} (${message(err)}); start it by hand`,
    );
  }
}

async function emergencyExit(env: StepEnv, signal: string): Promise<void> {
  env.ctx.say(`${signal} again: starting the worker if it is stopped, then exiting`);
  await ensureWorkerRunning(env);
  const head = await headOr(env.ctx, "unknown");
  await closeHistory(env.ctx, env.state, `interrupted head=${head} (${signal})`);
  await releaseLease(env.state).catch(() => undefined);
  for (const note of env.state.notes) env.ctx.say(note);
  env.ctx.exit(130);
}

/** First signal: stop after the current step and recover. Second: restore the worker and exit. */
function watchSignals(env: StepEnv, controller: AbortController): () => void {
  let received = 0;
  return env.ctx.onSignal((signal) => {
    received++;
    if (received === 1) {
      env.ctx.say(
        `${signal}: stopping after the current step and restoring (send it again to force)`,
      );
      controller.abort(signal);
      return;
    }
    void emergencyExit(env, signal);
  });
}

function snapshot(state: MoveState): Progress {
  return {
    frozen: state.frozen,
    movedTo: state.movedTo,
    installRan: state.installRan,
    restartAttempted: state.restartAttempted,
  };
}

function recoveryPlan(env: StepEnv, req: MoveRequest, head: string): RecoveryPlan {
  const progress = snapshot(env.state);
  if (req.mode === "rollback" && (progress.installRan || progress.restartAttempted)) {
    return {
      kind: "hands-off",
      reason: `the rollback to ${short(req.to)} failed after changing the runtime; not moving the checkout again`,
    };
  }
  return planRecovery({ from: req.from, head, progress, canFreeze: env.manager.canFreeze });
}

async function recover(
  env: StepEnv,
  req: MoveRequest,
  failed: StepsResult,
): Promise<MoveOutcomeWithoutSessions> {
  const { ctx, state } = env;
  const head = await headOr(ctx, req.to);
  const base = {
    from: req.from,
    to: req.to,
    completed: failed.completed,
    failure: failureOf(failed),
  };
  const plan = recoveryPlan(env, req, head);
  if (plan.kind === "hands-off") {
    await closeHistory(ctx, state, `needs-operator head=${head}`);
    const recovery = { completed: [], failure: { step: "recovery", detail: plan.reason } };
    return {
      ...base,
      outcome: "needs-operator",
      exitCode: EXIT_NEEDS_OPERATOR,
      recovery,
      notes: [],
    };
  }
  if (plan.steps.length > 0) {
    ctx.say(plan.changedBack ? `rolling back to ${short(req.from)}` : "putting things back");
  }
  const result = await runSteps({ ctx, manager: env.manager, state }, plan.steps);
  const recovery = { completed: result.completed, failure: failureOf(result) };
  if (!result.ok) {
    await closeHistory(ctx, state, `needs-operator head=${await headOr(ctx, head)}`);
    return {
      ...base,
      outcome: "needs-operator",
      exitCode: EXIT_NEEDS_OPERATOR,
      recovery,
      notes: [],
    };
  }
  if (plan.changedBack) {
    await closeHistory(ctx, state, `rolled-back to=${req.from}`);
    return { ...base, outcome: "rolled-back", exitCode: EXIT_ROLLED_BACK, recovery, notes: [] };
  }
  if (state.recorded) await closeHistory(ctx, state, `aborted at=${req.from}`);
  return { ...base, outcome: "refused", exitCode: EXIT_REFUSED, recovery, notes: [] };
}

/** Runs one move (apply or rollback); a failure is put back as far as it is safe to. */
export async function runMove(
  ctx: UpdateContext,
  manager: ServiceManager,
  req: MoveRequest,
): Promise<MoveOutcome> {
  const env: StepEnv = { ctx, manager, state: newMoveState() };
  const controller = new AbortController();
  const unwatch = watchSignals(env, controller);
  try {
    const steps = planMove({ ...req, canFreeze: manager.canFreeze });
    const forward = await runSteps({ ...env, signal: controller.signal }, steps);
    let outcome: MoveOutcomeWithoutSessions;
    if (forward.ok) {
      await closeHistory(ctx, env.state, `ok ${req.to}`);
      outcome = {
        outcome: "updated",
        exitCode: EXIT_OK,
        from: req.from,
        to: req.to,
        completed: forward.completed,
        failure: null,
        recovery: null,
        notes: [],
      };
    } else {
      ctx.say(`FAILED at ${forward.step}: ${forward.detail}`);
      outcome = await recover(env, req, forward);
    }
    await ensureWorkerRunning(env);
    return { ...outcome, notes: env.state.notes, ignored_sessions: env.state.ignoredSessions };
  } finally {
    unwatch();
    await releaseLease(env.state).catch(() => undefined);
  }
}
