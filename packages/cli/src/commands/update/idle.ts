import type { DispatchedHandoff, HostChild, UpdateContext } from "./types.js";

import { loadAdapterProgramNames, matchedAgentProgram } from "./agent-sessions.js";

const IDLE_POLL_MS = 15_000;
const MAX_LISTED = 5;
/** A warm agent session younger than this still counts as work. */
const AGENT_SESSION_MIN_AGE_S = 60;

export interface IdleProbe {
  idle: boolean;
  reasons: string[];
  dispatched: DispatchedHandoff[];
  approved: number | null;
  daemonError: string | null;
  /** Idle agent sessions under the worker that did not block: "<pid> <program>". */
  ignoredSessions: string[];
}

function listSome(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown}, … (+${String(items.length - MAX_LISTED)})` : shown;
}

function childLabel(child: HostChild): string {
  return `${String(child.pid)} ${child.argv[0] ?? ""}`.trim();
}

async function processReasons(
  ctx: UpdateContext,
  canIgnoreSessions: boolean,
): Promise<{ reasons: string[]; ignoredSessions: string[] }> {
  if (ctx.manager === null) return { reasons: [], ignoredSessions: [] };
  const reasons: string[] = [];
  const scopes = await ctx.manager.jobScopes();
  if (scopes.length > 0) reasons.push(`job scopes running: ${listSome(scopes)}`);
  const workerPid = (await ctx.manager.state()).worker.pid;
  if (workerPid === null) return { reasons, ignoredSessions: [] };
  const children = await ctx.host.childProcesses(workerPid);
  // Loading seats is only useful for the exemption; without a quiet daemon the
  // answer is "block" either way, so skip it entirely.
  const programs = canIgnoreSessions ? loadAdapterProgramNames(ctx.env, ctx.home) : null;
  const ignoredSessions: string[] = [];
  const blocking: string[] = [];
  for (const child of children) {
    const program = programs === null ? null : matchedAgentProgram(child.argv, programs);
    if (program !== null && child.ageS !== null && child.ageS >= AGENT_SESSION_MIN_AGE_S) {
      ignoredSessions.push(`${String(child.pid)} ${program}`);
    } else {
      blocking.push(childLabel(child));
    }
  }
  if (blocking.length > 0) {
    reasons.push(`worker has child processes: ${listSome(blocking)}`);
  }
  return { reasons, ignoredSessions };
}

/**
 * One idle probe. In-flight handoffs come from the daemon's own API; job scopes and
 * worker children catch work the daemon cannot see (a reconcile stage, a dispatch
 * whose claim is not recorded yet). Once the daemon reports nothing in flight, a
 * worker child that is an idle warm agent session from the seat config (old enough
 * that it is not just-started work) no longer blocks; every other child does.
 * `requireDaemon: false` (rollback) tolerates an unreachable daemon, since a dead
 * daemon is a common reason to roll back.
 */
export async function probeIdle(
  ctx: UpdateContext,
  opts: { requireDaemon: boolean },
): Promise<IdleProbe> {
  const reasons: string[] = [];
  const inFlight = await ctx.daemon.inFlight();
  let dispatched: DispatchedHandoff[] = [];
  let approved: number | null = null;
  let daemonError: string | null = null;
  if (inFlight.ok) {
    dispatched = inFlight.dispatched;
    approved = inFlight.approved;
    if (dispatched.length > 0) {
      const ids = dispatched.map((h) => `${h.handoffId.slice(0, 8)} (${h.agent})`);
      reasons.push(`${String(dispatched.length)} dispatched handoff(s): ${listSome(ids)}`);
    }
  } else {
    daemonError = inFlight.error;
    if (opts.requireDaemon) reasons.push(`cannot list in-flight handoffs: ${inFlight.error}`);
  }
  const quiet = inFlight.ok && dispatched.length === 0 && approved === 0;
  const process = await processReasons(ctx, quiet);
  reasons.push(...process.reasons);
  return {
    idle: reasons.length === 0,
    reasons,
    dispatched,
    approved,
    daemonError,
    ignoredSessions: process.ignoredSessions,
  };
}

export type IdleWait =
  | { ok: true; waitedS: number; ignoredSessions: string[] }
  | { ok: false; reasons: string[] };

function ignoredSessionsLine(ignored: string[]): string | null {
  if (ignored.length === 0) return null;
  return `ignoring ${String(ignored.length)} idle agent session(s): ${listSome(ignored)}`;
}

/** Polls until idle or `budgetS` runs out; a budget of 0 probes once. */
export async function waitForIdle(
  ctx: UpdateContext,
  opts: {
    budgetS: number;
    requireDaemon: boolean;
    pollMs?: number;
    signal?: AbortSignal | undefined;
  },
): Promise<IdleWait> {
  const start = ctx.clock.now();
  const pollMs = opts.pollMs ?? IDLE_POLL_MS;
  let lastSaid = "";
  let lastIgnoredSaid = "";
  for (;;) {
    if (opts.signal?.aborted)
      return { ok: false, reasons: [`interrupted by ${String(opts.signal.reason)}`] };
    const probe = await probeIdle(ctx, opts);
    const ignoredLine = ignoredSessionsLine(probe.ignoredSessions);
    if (ignoredLine !== null && ignoredLine !== lastIgnoredSaid) {
      ctx.say(ignoredLine);
      lastIgnoredSaid = ignoredLine;
    }
    const waitedMs = ctx.clock.now() - start;
    if (probe.idle) {
      return {
        ok: true,
        waitedS: Math.round(waitedMs / 1000),
        ignoredSessions: probe.ignoredSessions,
      };
    }
    if (waitedMs >= opts.budgetS * 1000) return { ok: false, reasons: probe.reasons };
    const line = probe.reasons.join("; ");
    if (line !== lastSaid) ctx.say(`waiting for idle: ${line}`);
    lastSaid = line;
    await ctx.clock.sleep(Math.min(pollMs, opts.budgetS * 1000 - waitedMs));
  }
}
