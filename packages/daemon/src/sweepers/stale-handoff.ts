import type { Services } from "@penumbra/core";
import { classifyDispatchReliability } from "@penumbra/core";
import { resolveSweeperSqlCutoffMs } from "./stale-handoff-thresholds.js";

export interface StaleHandoffSweeperOpts {
  services: Services;
  /**
   * Resolves the stale threshold per handoff.
   * Accepts either a fixed millisecond value or a task-type-aware resolver.
   * Use `staleAfterMs` only for backward compatibility.
   */
  resolveStaleAfterMs?: number | ((taskType: string | null | undefined) => number);
  /** @deprecated Use `resolveStaleAfterMs`. */
  staleAfterMs?: number | ((taskType: string | null | undefined) => number);
  /** Default 300_000 (5 min). Don't force-resolve a handoff whose latest event is newer than this. */
  activityIdleMs?: number;
  /** Default 60_000. Per-handoff cooldown — don't re-process the same handoff within this window. */
  cooldownMs?: number;
  /** Default false. When enabled, fresh heartbeats can temporarily defer stale force-resolution. */
  livenessCheckEnabled?: boolean;
  /** Default 30 min. Upper bound for liveness deferral measured from handoff ts. */
  maxAliveGraceMs?: number;
  /**
   * Returns true when a worker heartbeat is fresh.
   * Missing worker ids, unknown workers, and probe errors are treated as not fresh (fail-closed).
   */
  isWorkerHeartbeatFresh?: (workerId: string) => boolean;
  log?: { warn?: (obj: unknown, msg?: string) => void };
}

export interface SweepTickResult {
  candidates: string[];
  resolved: string[];
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ALIVE_GRACE_MS = 30 * 60_000;

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
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const livenessCheckEnabled = opts.livenessCheckEnabled ?? false;
  const maxAliveGraceMs = opts.maxAliveGraceMs ?? DEFAULT_MAX_ALIVE_GRACE_MS;
  const nowDate = now();
  const nowMs = nowDate.getTime();
  const configuredStaleAfterMs = opts.resolveStaleAfterMs ?? opts.staleAfterMs;
  if (opts.staleAfterMs !== undefined && opts.resolveStaleAfterMs === undefined) {
    opts.log?.warn?.(
      { option: "staleAfterMs" },
      "staleAfterMs is deprecated; use resolveStaleAfterMs instead",
    );
  }
  const resolveStaleAfterMsForHandoff: (taskType: string | null) => number = (() => {
    if (typeof configuredStaleAfterMs === "function") return configuredStaleAfterMs;
    const staleAfterMs = configuredStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    return () => staleAfterMs;
  })();
  const sqlCutoffMs = resolveSweeperSqlCutoffMs(configuredStaleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const sqlCutoffIso = new Date(nowMs - sqlCutoffMs).toISOString();

  const rows = services.db
    .query<
      { handoff_id: string },
      [string]
    >(`SELECT handoff_id FROM handoffs WHERE status='dispatched' AND ts < ?`)
    .all(sqlCutoffIso);

  const candidates: string[] = [];
  const resolved: string[] = [];
  const candidatesForDecision: Array<{
    handoff_id: string;
    handoff: NonNullable<ReturnType<typeof services.handoffReader.get>>;
    staleAfterMs: number;
  }> = [];

  for (const { handoff_id } of rows) {
    const last = state.lastSwept.get(handoff_id);
    if (last !== undefined && nowMs - last < cooldownMs) continue;
    state.lastSwept.set(handoff_id, nowMs);

    const handoff = services.handoffReader.get(handoff_id);
    if (!handoff) continue;

    const staleAfterMs: number = resolveStaleAfterMsForHandoff(handoff.chain_task_type);
    const handoffAgeMs = nowMs - new Date(handoff.ts).getTime();
    if (handoffAgeMs <= staleAfterMs) continue;

    if (livenessCheckEnabled && handoffAgeMs < maxAliveGraceMs) {
      const workerId = handoff.worker_id;
      if (workerId) {
        try {
          if (opts.isWorkerHeartbeatFresh?.(workerId) === true) continue;
        } catch (err) {
          opts.log?.warn?.(
            { handoff_id, worker_id: workerId, err: String(err) },
            "stale-handoff liveness probe failed; proceeding fail-closed",
          );
        }
      }
    }

    candidates.push(handoff_id);
    candidatesForDecision.push({ handoff_id, handoff, staleAfterMs });
  }

  const eventsByHandoff = new Map<string, { kind: string; ts: string }[]>();
  if (candidatesForDecision.length > 0) {
    const placeholders = candidatesForDecision.map(() => "?").join(",");
    const events = services.db
      .query<
        { handoff_id: string; kind: string; ts: string },
        string[]
      >(`SELECT handoff_id, kind, ts FROM dispatch_events WHERE handoff_id IN (${placeholders}) ORDER BY handoff_id, ts ASC`)
      .all(...candidatesForDecision.map(({ handoff_id }) => handoff_id));
    for (const event of events) {
      let list = eventsByHandoff.get(event.handoff_id);
      if (!list) {
        list = [];
        eventsByHandoff.set(event.handoff_id, list);
      }
      list.push({ kind: event.kind, ts: event.ts });
    }
  }

  const activityIdleMs = opts.activityIdleMs ?? 300_000;

  const resolveStaleHandoff = services.db.transaction(
    (handoffId: string, tsIso: string): boolean => {
      const activeCheck = services.db
        .query<
          { found: 1 },
          [string, string]
        >(`SELECT 1 AS found FROM dispatch_events WHERE handoff_id=? AND (kind='dispatch.end' OR ts >= ?) LIMIT 1`)
        .get(handoffId, new Date(nowMs - activityIdleMs).toISOString());

      if (activeCheck) {
        return false;
      }

      const markedFailed = services.handoffWriter.markFailed(handoffId, {
        reason: "stale_force_resolve",
        ts: tsIso,
        resolved_by: "stale-handoff-sweeper",
      });
      if (!markedFailed) {
        const current = services.handoffReader.get(handoffId);
        if (
          current &&
          (current.status === "completed" ||
            current.status === "failed" ||
            current.status === "rejected")
        ) {
          return false;
        }
        throw new Error(`failed to mark stale handoff ${handoffId} as failed`);
      }

      services.db
        .query<
          unknown,
          [string, string | null, string, string, string, string]
        >(`INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          handoffId,
          null,
          "sweeper",
          "dispatch.end",
          tsIso,
          JSON.stringify({
            status: "failed",
            reason: "stale_force_resolve",
            classifier_status: "non_terminal_stale",
          }),
        );

      return true;
    },
  );

  for (const { handoff_id, handoff, staleAfterMs } of candidatesForDecision) {
    const events = eventsByHandoff.get(handoff_id) ?? [];

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
      dispatchEndCommitted: null,
      reconciled: null,
      adapterStreaming: null,
      now: nowDate,
      staleAfterMs,
      activityIdleMs: opts.activityIdleMs,
    } as any);

    if (report.status !== "non_terminal_stale") continue;

    // If a dispatch.end already exists, this is a "terminal-event-but-status-not-flipped"
    // bug, not a wedged dispatch. Leave it for a different recovery path.
    if (events.some((event) => event.kind === "dispatch.end")) continue;

    const tsIso = nowDate.toISOString();
    try {
      const didResolve = resolveStaleHandoff(handoff_id, tsIso);
      if (didResolve) {
        resolved.push(handoff_id);
      }
    } catch (err) {
      opts.log?.warn?.({ handoff_id, err: String(err) }, "failed to force-resolve stale handoff");
    }
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
      opts.log?.warn?.({ err: String(err) }, "stale-handoff sweep failed");
    }
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return () => clearInterval(timer);
}
