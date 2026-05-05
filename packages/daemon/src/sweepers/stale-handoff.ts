import type { Services } from '@penumbra/core';
import { classifyDispatchReliability } from '@penumbra/core';

export interface StaleHandoffSweeperOpts {
  services: Services;
  /** Default 5 * 60_000. */
  staleAfterMs?: number;
  /** Default 60_000. Per-handoff cooldown — don't re-process the same handoff within this window. */
  cooldownMs?: number;
  log?: { warn?: (obj: unknown, msg?: string) => void };
}

export interface SweepTickResult {
  candidates: string[];
  resolved: string[];
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * One sweep tick: find handoffs stuck in `dispatched` past the stale threshold
 * with no `dispatch.end`, and force-resolve them to `failed` via a synthetic
 * terminal event. Idempotent — the per-handoff cooldown map prevents reprocessing.
 */
export function runStaleHandoffSweep(
  opts: StaleHandoffSweeperOpts,
  state: { lastSwept: Map<string, number> },
  now: () => Date,
): SweepTickResult {
  const { services } = opts;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const nowDate = now();
  const nowMs = nowDate.getTime();
  const staleCutoffIso = new Date(nowMs - staleAfterMs).toISOString();

  const rows = services.db
    .query<{ handoff_id: string }, [string]>(
      `SELECT handoff_id FROM handoffs WHERE status='dispatched' AND ts < ?`,
    )
    .all(staleCutoffIso);

  const candidates: string[] = [];
  const resolved: string[] = [];

  for (const { handoff_id } of rows) {
    const last = state.lastSwept.get(handoff_id);
    if (last !== undefined && nowMs - last < cooldownMs) continue;
    state.lastSwept.set(handoff_id, nowMs);

    const handoff = services.handoffReader.get(handoff_id);
    if (!handoff) continue;
    candidates.push(handoff_id);

    const events = services.db
      .query<{ kind: string; ts: string }, [string]>(
        `SELECT kind, ts FROM dispatch_events WHERE handoff_id = ? ORDER BY ts ASC`,
      )
      .all(handoff_id);

    const report = classifyDispatchReliability({
      handoff: {
        handoff_id,
        status: handoff.status,
        ts: handoff.ts,
        resolved_at: handoff.resolved_at,
        cancel_requested_at: handoff.cancel_requested_at,
        chain_task_type: handoff.chain_task_type,
        use_worktree: handoff.use_worktree === true || (handoff.use_worktree as unknown) === 1,
      },
      events,
      responseCount: 0,
      finalResponseText: null,
      worktreeChanged: null,
      reconciled: null,
      adapterStreaming: null,
      now: nowDate,
      staleAfterMs,
    });

    if (report.status !== 'non_terminal_stale') continue;

    // If a dispatch.end already exists, this is a "terminal-event-but-status-not-flipped"
    // bug, not a wedged dispatch. Leave it for a different recovery path.
    if (events.some((event) => event.kind === 'dispatch.end')) continue;

    const tsIso = nowDate.toISOString();
    services.db
      .query<unknown, [string, string | null, string, string, string, string]>(
        `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff_id,
        null,
        'sweeper',
        'dispatch.end',
        tsIso,
        JSON.stringify({
          status: 'failed',
          reason: 'stale_force_resolve',
          classifier_status: 'non_terminal_stale',
        }),
      );

    services.handoffWriter.markFailed(handoff_id, {
      reason: 'stale_force_resolve',
      ts: tsIso,
      resolved_by: 'stale-handoff-sweeper',
    });

    resolved.push(handoff_id);
  }

  return { candidates, resolved };
}

/** Schedules the sweep on a recurring interval. Returns a cancel function. */
export function startStaleHandoffSweeper(
  opts: StaleHandoffSweeperOpts,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  now: () => Date = () => new Date(),
): () => void {
  const state = { lastSwept: new Map<string, number>() };
  const timer = setInterval(() => {
    try {
      runStaleHandoffSweep(opts, state, now);
    } catch (err) {
      opts.log?.warn?.({ err: String(err) }, 'stale-handoff sweep failed');
    }
  }, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
