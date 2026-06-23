import type { DispatchReliabilityInput, Services } from "@penumbra/core";

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

interface StaleCandidate {
  handoff_id: string;
  handoff: NonNullable<ReturnType<Services["handoffReader"]["get"]>>;
  staleAfterMs: number;
}

interface StaleSweepConfig {
  nowDate: Date;
  nowMs: number;
  cooldownMs: number;
  livenessCheckEnabled: boolean;
  maxAliveGraceMs: number;
  configuredStaleAfterMs: StaleAfterResolver;
  resolveStaleAfterMsForHandoff: (taskType: string | null) => number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ALIVE_GRACE_MS = 30 * 60_000;

type StaleAfterResolver = number | ((taskType: string | null | undefined) => number);
type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };
type StaleHandoffSweeperOptsWithLegacy = Omit<StaleHandoffSweeperOpts, "staleAfterMs"> & {
  staleAfterMs?: StaleAfterResolver;
};

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

function normalizeUseWorktree(value: unknown): boolean {
  return value === true || value === 1;
}

function resolveStaleSweepConfig(opts: StaleHandoffSweeperOpts, nowDate: Date): StaleSweepConfig {
  const legacyStaleAfterMs = (opts as StaleHandoffSweeperOptsWithLegacy).staleAfterMs;
  const configuredStaleAfterMs = opts.resolveStaleAfterMs ?? legacyStaleAfterMs;
  if (legacyStaleAfterMs !== undefined && opts.resolveStaleAfterMs === undefined) {
    opts.log?.warn?.(
      { option: "staleAfterMs" },
      "staleAfterMs is deprecated; use resolveStaleAfterMs instead",
    );
  }
  const resolveStaleAfterMsForHandoff = ((): ((taskType: string | null) => number) => {
    if (typeof configuredStaleAfterMs === "function") return configuredStaleAfterMs;
    const staleAfterMs = configuredStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    return () => staleAfterMs;
  })();

  return {
    nowDate,
    nowMs: nowDate.getTime(),
    cooldownMs: opts.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    livenessCheckEnabled: opts.livenessCheckEnabled ?? false,
    maxAliveGraceMs: opts.maxAliveGraceMs ?? DEFAULT_MAX_ALIVE_GRACE_MS,
    configuredStaleAfterMs: configuredStaleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    resolveStaleAfterMsForHandoff,
  };
}

function hasFreshWorkerHeartbeat(
  opts: StaleHandoffSweeperOpts,
  handoffId: string,
  workerId: string | null | undefined,
): boolean {
  if (!workerId) return false;
  try {
    return opts.isWorkerHeartbeatFresh?.(workerId) === true;
  } catch (err) {
    opts.log?.warn?.(
      { handoff_id: handoffId, worker_id: workerId, err: String(err) },
      "stale-handoff liveness probe failed; proceeding fail-closed",
    );
    return false;
  }
}

function collectStaleCandidates(
  opts: StaleHandoffSweeperOpts,
  state: { lastSwept: Map<string, number> },
  config: StaleSweepConfig,
): { candidates: string[]; candidatesForDecision: StaleCandidate[] } {
  const { services } = opts;
  const sqlCutoffMs = resolveSweeperSqlCutoffMs(config.configuredStaleAfterMs);
  const sqlCutoffIso = new Date(config.nowMs - sqlCutoffMs).toISOString();
  const rows = services.db
    .query<
      { handoff_id: string },
      [string]
    >(`SELECT handoff_id FROM handoffs WHERE status='dispatched' AND ts < ?`)
    .all(sqlCutoffIso);
  const candidates: string[] = [];
  const candidatesForDecision: StaleCandidate[] = [];

  for (const { handoff_id } of rows) {
    const last = state.lastSwept.get(handoff_id);
    if (last !== undefined && config.nowMs - last < config.cooldownMs) continue;
    state.lastSwept.set(handoff_id, config.nowMs);

    const handoff = services.handoffReader.get(handoff_id);
    if (!handoff) continue;

    const staleAfterMs = config.resolveStaleAfterMsForHandoff(handoff.chain_task_type);
    const handoffAgeMs = config.nowMs - new Date(handoff.ts).getTime();
    if (handoffAgeMs <= staleAfterMs) continue;
    if (
      config.livenessCheckEnabled &&
      handoffAgeMs < config.maxAliveGraceMs &&
      hasFreshWorkerHeartbeat(opts, handoff_id, handoff.worker_id)
    )
      continue;

    candidates.push(handoff_id);
    candidatesForDecision.push({ handoff_id, handoff, staleAfterMs });
  }

  return { candidates, candidatesForDecision };
}

function readDispatchEventsByHandoff(
  services: Services,
  candidatesForDecision: StaleCandidate[],
): Map<string, { kind: string; ts: string }[]> {
  const eventsByHandoff = new Map<string, { kind: string; ts: string }[]>();
  if (candidatesForDecision.length === 0) return eventsByHandoff;

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
  return eventsByHandoff;
}

function makeResolveStaleHandoff(
  services: Services,
  nowMs: number,
  activityIdleMs: number,
): (handoffId: string, tsIso: string) => boolean {
  return services.db.transaction((handoffId: string, tsIso: string): boolean => {
    const activeCheck = services.db
      .query<
        { found: 1 },
        [string, string]
      >(`SELECT 1 AS found FROM dispatch_events WHERE handoff_id=? AND (kind='dispatch.end' OR ts >= ?) LIMIT 1`)
      .get(handoffId, new Date(nowMs - activityIdleMs).toISOString());

    if (activeCheck) return false;

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
  });
}

function buildReliabilityInput(args: {
  candidate: StaleCandidate;
  events: { kind: string; ts: string }[];
  nowDate: Date;
  activityIdleMs?: number;
}): DispatchReliabilityInput {
  const { handoff, handoff_id, staleAfterMs } = args.candidate;
  return {
    handoff: {
      handoff_id,
      status: handoff.status,
      ts: handoff.ts,
      resolved_at: handoff.resolved_at,
      cancel_requested_at: handoff.cancel_requested_at,
      chain_task_type: handoff.chain_task_type,
      use_worktree: normalizeUseWorktree(handoff.use_worktree),
    },
    events: args.events,
    responseCount: 0,
    finalResponseText: null,
    worktreeChanged: null,
    dispatchEndCommitted: null,
    reconciled: null,
    adapterStreaming: null,
    now: args.nowDate,
    staleAfterMs,
    activityIdleMs: args.activityIdleMs,
  };
}

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
  const nowDate = now();
  const config = resolveStaleSweepConfig(opts, nowDate);
  const resolved: string[] = [];
  const { candidates, candidatesForDecision } = collectStaleCandidates(opts, state, config);
  const eventsByHandoff = readDispatchEventsByHandoff(services, candidatesForDecision);
  const activityIdleMs = opts.activityIdleMs ?? 300_000;
  const resolveStaleHandoff = makeResolveStaleHandoff(services, config.nowMs, activityIdleMs);

  for (const candidate of candidatesForDecision) {
    const events = eventsByHandoff.get(candidate.handoff_id) ?? [];
    const input = buildReliabilityInput({ candidate, events, nowDate, activityIdleMs });
    const report = classifyDispatchReliability(input);

    if (report.status !== "non_terminal_stale") continue;

    // If a dispatch.end already exists, this is a "terminal-event-but-status-not-flipped"
    // bug, not a wedged dispatch. Leave it for a different recovery path.
    if (events.some((event) => event.kind === "dispatch.end")) continue;

    const tsIso = nowDate.toISOString();
    try {
      const didResolve = resolveStaleHandoff(candidate.handoff_id, tsIso);
      if (didResolve) {
        resolved.push(candidate.handoff_id);
      }
    } catch (err) {
      opts.log?.warn?.(
        { handoff_id: candidate.handoff_id, err: String(err) },
        "failed to force-resolve stale handoff",
      );
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
  maybeUnref(timer);
  return () => {
    clearInterval(timer);
  };
}
