import type { InstallLease, ServiceManager, UpdateContext } from "./types.js";

import { appendHistory } from "./history.js";
import { probeIdle, waitForIdle } from "./idle.js";
import { type Progress, type Step, stepLabel } from "./plan.js";
import { type LogWatch, verifyRuntime, watchLogs } from "./verify.js";

export interface MoveState extends Progress {
  /** The `from=` history line is written; a closing line is owed. */
  recorded: boolean;
  watch: LogWatch | null;
  lease: InstallLease | null;
  notes: string[];
}

export interface StepEnv {
  ctx: UpdateContext;
  manager: ServiceManager;
  state: MoveState;
  /** Aborted by the first SIGINT/SIGTERM/SIGHUP during the forward run. */
  signal?: AbortSignal;
}

export type StepsResult =
  | { ok: true; completed: string[] }
  | { ok: false; completed: string[]; step: string; detail: string };

export function newMoveState(): MoveState {
  return {
    frozen: false,
    movedTo: null,
    installRan: false,
    restartAttempted: false,
    recorded: false,
    watch: null,
    lease: null,
    notes: [],
  };
}

export async function releaseLease(state: MoveState): Promise<void> {
  const lease = state.lease;
  state.lease = null;
  await lease?.release();
}

function busyDetail(waitIdleS: number, reasons: string[]): string {
  return `still busy after ${String(waitIdleS)}s (${reasons.join("; ")}); retry later or raise --wait-idle`;
}

async function runWaitIdle(env: StepEnv, requireDaemon: boolean): Promise<string | null> {
  const { ctx } = env;
  const res = await waitForIdle(ctx, {
    budgetS: ctx.options.waitIdleS,
    requireDaemon,
    signal: env.signal,
  });
  return res.ok ? null : busyDetail(ctx.options.waitIdleS, res.reasons);
}

/**
 * Idle, then (with `gate`) the heavy-job lock + memory admission, then idle again
 * while holding it. The lock is never held while waiting for a dispatch: that
 * dispatch's own reconcile stages may need it.
 */
async function runSettle(
  env: StepEnv,
  step: Extract<Step, { kind: "settle" }>,
): Promise<string | null> {
  const { ctx, state } = env;
  const deadline = ctx.clock.now() + ctx.options.waitIdleS * 1000;
  for (;;) {
    const budgetS = Math.max(0, Math.ceil((deadline - ctx.clock.now()) / 1000));
    const idle = await waitForIdle(ctx, {
      budgetS,
      requireDaemon: step.requireDaemon,
      signal: env.signal,
    });
    if (!idle.ok) return busyDetail(ctx.options.waitIdleS, idle.reasons);
    if (!step.gate) return null;
    ctx.say(`waiting for the heavy-job lock (${ctx.heavyLock.path}) and memory admission`);
    const gate = await ctx.install.acquire();
    if (!gate.ok) return `heavy-job gate: ${gate.detail}`;
    const again = await probeIdle(ctx, { requireDaemon: step.requireDaemon });
    if (again.idle) {
      state.lease = gate.lease;
      return null;
    }
    await gate.lease.release();
    if (ctx.clock.now() >= deadline) return busyDetail(ctx.options.waitIdleS, again.reasons);
  }
}

async function runGuard(env: StepEnv, expect: string[]): Promise<string | null> {
  const head = await env.ctx.git.head();
  if (!expect.includes(head)) {
    return `HEAD moved to ${head.slice(0, 12)} (expected ${expect.map((s) => s.slice(0, 12)).join(" or ")}); a commit landed in ${env.ctx.repo} meanwhile, so git is left untouched`;
  }
  const tracked = await env.ctx.git.trackedChanges();
  if (tracked.length > 0) {
    return `tracked changes appeared in ${env.ctx.repo} (${tracked
      .slice(0, 5)
      .map((l) => l.trim())
      .join("; ")}); git is left untouched`;
  }
  return null;
}

async function runInstall(env: StepEnv): Promise<string | null> {
  const { ctx, state } = env;
  if (state.lease === null) {
    ctx.say(`waiting for the heavy-job lock (${ctx.heavyLock.path}) and memory admission`);
    const gate = await ctx.install.acquire();
    if (!gate.ok) return `bun install not started: heavy-job gate: ${gate.detail}`;
    state.lease = gate.lease;
  }
  ctx.say(`${ctx.bunPath} install --frozen-lockfile (memory-capped job scope)`);
  try {
    const res = await ctx.install.run(ctx.repo, env.signal).catch((err: unknown) => {
      // Unknown how far it got: treat node_modules as touched so recovery reinstalls.
      state.installRan = true;
      throw err;
    });
    state.installRan ||= res.ran;
    return res.ok ? null : `bun install failed: ${res.detail}`;
  } finally {
    await releaseLease(state);
  }
}

async function runService(env: StepEnv, kind: "freeze" | "restart" | "unfreeze"): Promise<null> {
  const { ctx, manager, state } = env;
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

async function runVerify(
  env: StepEnv,
  step: Extract<Step, { kind: "verify" }>,
): Promise<string | null> {
  const { ctx, manager, state } = env;
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

async function runMoveStep(env: StepEnv, step: Extract<Step, { kind: "move" }>): Promise<null> {
  await (step.how === "fast-forward"
    ? env.ctx.git.fastForward(step.to)
    : env.ctx.git.resetHard(step.to));
  env.state.movedTo = step.to;
  return null;
}

async function runStep(env: StepEnv, step: Step): Promise<string | null> {
  switch (step.kind) {
    case "settle":
      return await runSettle(env, step);
    case "wait-idle":
      return await runWaitIdle(env, step.requireDaemon);
    case "guard":
      return await runGuard(env, step.expect);
    case "record":
      await appendHistory(env.ctx.fs, env.ctx.clock, env.ctx.historyPath, step.entry);
      env.state.recorded = true;
      return null;
    case "move":
      return await runMoveStep(env, step);
    case "install":
      return await runInstall(env);
    case "verify":
      return await runVerify(env, step);
    case "freeze":
    case "restart":
    case "unfreeze":
      return await runService(env, step.kind);
  }
}

function abortReason(signal: AbortSignal | undefined): string | null {
  if (!signal?.aborted) return null;
  return `interrupted by ${String(signal.reason)}`;
}

export async function runSteps(env: StepEnv, steps: Step[]): Promise<StepsResult> {
  const completed: string[] = [];
  for (const step of steps) {
    const label = stepLabel(step);
    let detail = abortReason(env.signal);
    if (detail === null) {
      env.ctx.say(`→ ${label}`);
      try {
        detail = (await runStep(env, step)) ?? abortReason(env.signal);
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    if (detail !== null) return { ok: false, completed, step: label, detail };
    completed.push(label);
  }
  return { ok: true, completed };
}
