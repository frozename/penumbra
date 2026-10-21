import type { DispatchedHandoff, UpdateContext } from "./types.js";

const IDLE_POLL_MS = 15_000;
const MAX_LISTED = 5;

export interface IdleProbe {
  idle: boolean;
  reasons: string[];
  dispatched: DispatchedHandoff[];
  approved: number | null;
  daemonError: string | null;
}

function listSome(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown}, … (+${String(items.length - MAX_LISTED)})` : shown;
}

async function processReasons(ctx: UpdateContext): Promise<string[]> {
  if (ctx.manager === null) return [];
  const reasons: string[] = [];
  const scopes = await ctx.manager.jobScopes();
  if (scopes.length > 0) reasons.push(`job scopes running: ${listSome(scopes)}`);
  const workerPid = (await ctx.manager.state()).worker.pid;
  if (workerPid !== null) {
    const children = await ctx.host.children(workerPid);
    if (children.length > 0) reasons.push(`worker has child processes: ${listSome(children)}`);
  }
  return reasons;
}

/**
 * One idle probe. In-flight handoffs come from the daemon's own API; job scopes and
 * worker children catch work the daemon cannot see (a reconcile stage, a dispatch
 * whose claim is not recorded yet). `requireDaemon: false` (rollback) tolerates an
 * unreachable daemon, since a dead daemon is a common reason to roll back.
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
  reasons.push(...(await processReasons(ctx)));
  return { idle: reasons.length === 0, reasons, dispatched, approved, daemonError };
}

export type IdleWait = { ok: true; waitedS: number } | { ok: false; reasons: string[] };

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
  for (;;) {
    if (opts.signal?.aborted)
      return { ok: false, reasons: [`interrupted by ${String(opts.signal.reason)}`] };
    const probe = await probeIdle(ctx, opts);
    const waitedMs = ctx.clock.now() - start;
    if (probe.idle) return { ok: true, waitedS: Math.round(waitedMs / 1000) };
    if (waitedMs >= opts.budgetS * 1000) return { ok: false, reasons: probe.reasons };
    const line = probe.reasons.join("; ");
    if (line !== lastSaid) ctx.say(`waiting for idle: ${line}`);
    lastSaid = line;
    await ctx.clock.sleep(Math.min(pollMs, opts.budgetS * 1000 - waitedMs));
  }
}
