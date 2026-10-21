export type Step =
  | { kind: "freeze" }
  | { kind: "guard"; expect: string[] }
  | { kind: "install" }
  | { kind: "move"; how: "fast-forward" | "reset"; to: string }
  | { kind: "record"; entry: string }
  | { kind: "restart" }
  | { kind: "settle"; requireDaemon: boolean; gate: boolean }
  | { kind: "unfreeze" }
  /** `expect: null` skips the HEAD check (this run did not move the checkout). */
  | { kind: "verify"; expect: string | null; restarted: "both" | "worker" }
  | { kind: "wait-idle"; requireDaemon: boolean };

/** What a run has done to the checkout and the runtime so far. */
export interface Progress {
  frozen: boolean;
  /** The commit this run moved the checkout to, or null before the move. */
  movedTo: string | null;
  installRan: boolean;
  restartAttempted: boolean;
}

export type RecoveryPlan =
  | { kind: "steps"; steps: Step[]; changedBack: boolean }
  | { kind: "hands-off"; reason: string };

function short(sha: string): string {
  return sha.slice(0, 12);
}

export function stepLabel(step: Step): string {
  switch (step.kind) {
    case "move":
      return `${step.how} ${short(step.to)}`;
    case "record":
      return `record "${step.entry}"`;
    case "verify":
      return step.expect === null ? "verify" : `verify ${short(step.expect)}`;
    case "guard":
      return `guard HEAD=${step.expect.map(short).join("|")}, clean`;
    case "settle":
      return step.gate ? "wait-idle + heavy-job gate" : "wait-idle";
    case "freeze":
    case "install":
    case "restart":
    case "unfreeze":
    case "wait-idle":
      return step.kind;
  }
}

/**
 * The ordered procedure for one move of the checkout.
 *
 * - settle: wait until idle, then (when bun install will run) take the heavy-job
 *   lock and memory admission, so those waits never happen with the worker stopped.
 * - freeze (systemd): stop the worker so it claims nothing while the checkout and
 *   node_modules change under it.
 * - guard: HEAD must still be `from` with a clean tracked tree; a land into this
 *   checkout during the wait aborts before git is touched.
 * - record, move, install, then a last idle check (daemon-bound scopes, extra
 *   workers, launchd's live worker) right before the restart.
 */
export function planMove(input: {
  mode: "apply" | "rollback";
  from: string;
  to: string;
  depsChanged: boolean;
  canFreeze: boolean;
}): Step[] {
  const requireDaemon = input.mode === "apply";
  const steps: Step[] = [{ kind: "settle", requireDaemon, gate: input.depsChanged }];
  if (input.canFreeze) steps.push({ kind: "freeze" });
  steps.push(
    { kind: "guard", expect: [input.from] },
    { kind: "record", entry: `${input.mode} from=${input.from} to=${input.to}` },
    { kind: "move", how: input.mode === "apply" ? "fast-forward" : "reset", to: input.to },
  );
  if (input.depsChanged) steps.push({ kind: "install" });
  steps.push(
    { kind: "wait-idle", requireDaemon },
    { kind: "restart" },
    { kind: "verify", expect: input.to, restarted: "both" },
  );
  return steps;
}

function unfreezeSteps(expect: string | null, frozen: boolean): Step[] {
  return frozen ? [{ kind: "unfreeze" }, { kind: "verify", expect, restarted: "worker" }] : [];
}

/**
 * Steps that put things back on `from` after a failed move, given how far it got.
 * git is only reset when HEAD is still a commit this run produced or started from;
 * anything else (a land during the run) is left alone for the operator. The
 * runtime is only restarted when this run restarted or reinstalled it, and then
 * only once idle.
 */
export function planRecovery(input: {
  from: string;
  head: string;
  progress: Progress;
  canFreeze: boolean;
}): RecoveryPlan {
  const { from, head, progress } = input;
  const runtimeChanged = progress.installRan || progress.restartAttempted;
  if (progress.movedTo === null && !runtimeChanged) {
    return { kind: "steps", steps: unfreezeSteps(null, progress.frozen), changedBack: false };
  }
  if (head !== from && head !== progress.movedTo) {
    return {
      kind: "hands-off",
      reason: `HEAD is ${short(head)}, neither ${short(from)} nor ${short(progress.movedTo ?? from)} that this run moved to; leaving git untouched`,
    };
  }
  const steps: Step[] = [];
  if (input.canFreeze && progress.restartAttempted && !progress.frozen) {
    steps.push({ kind: "freeze" });
  }
  if (head !== from) {
    steps.push({ kind: "guard", expect: [head] }, { kind: "move", how: "reset", to: from });
  }
  if (progress.installRan) steps.push({ kind: "install" });
  if (runtimeChanged) {
    steps.push(
      { kind: "wait-idle", requireDaemon: false },
      { kind: "restart" },
      { kind: "verify", expect: from, restarted: "both" },
    );
  } else {
    steps.push(...unfreezeSteps(from, progress.frozen));
  }
  return { kind: "steps", steps, changedBack: runtimeChanged };
}
