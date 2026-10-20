import type { Services } from "@penumbra/core";

import { closeLane, ORPHAN_SWEEPER_REASON_PREFIX } from "@penumbra/core";

const closeLaneWithLog = closeLane;

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_TRIVIAL_GRACE_MS = 120 * 60_000;
const DEFAULT_NON_TRIVIAL_GRACE_MS = 1440 * 60_000;

const TERMINAL_HANDOFF_STATUSES = ["completed", "failed", "rejected", "expired"] as const;

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export interface RunOrphanLanesSweepOpts {
  /** Fallback for both classes; explicit per-class options take precedence. */
  graceMs?: number;
  trivialGraceMs?: number;
  nonTrivialGraceMs?: number;
  nowIso?: string;
}

export interface OrphanLanesSweepResult {
  scanned: number;
  closed: number;
  lane_ids: string[];
}

/**
 * Closes lanes that are still gate_status='open' but whose implementer handoff
 * has been terminal past its class grace, measured from the later of resolution
 * and lane opening. Skips lanes
 * with an in-flight reviewer handoff (non-terminal reviewer = lane is still
 * being reviewed). Idempotent — SQL UPDATE WHERE gate_status='open' guards
 * against double-close.
 */
export function runOrphanLanesSweep(
  services: Services,
  opts: RunOrphanLanesSweepOpts = {},
): OrphanLanesSweepResult {
  const trivialGraceMs = opts.trivialGraceMs ?? opts.graceMs ?? DEFAULT_TRIVIAL_GRACE_MS;
  const nonTrivialGraceMs = opts.nonTrivialGraceMs ?? opts.graceMs ?? DEFAULT_NON_TRIVIAL_GRACE_MS;
  const now_iso = opts.nowIso ?? services.clock().toISOString();
  const trivialCutoff = new Date(Date.parse(now_iso) - trivialGraceMs).toISOString();
  const nonTrivialCutoff = new Date(Date.parse(now_iso) - nonTrivialGraceMs).toISOString();

  const rows = services.db
    .query<
      {
        lane_id: string;
        task_class: string;
        implementer_handoff: string;
        reviewer_handoff: string | null;
        handoff_status: string;
        handoff_resolved_at: string | null;
        reviewer_status: string | null;
      },
      [string, string]
    >(
      `
    SELECT
      l.lane_id,
      l.task_class,
      l.implementer_handoff,
      l.reviewer_handoff,
      h.status AS handoff_status,
      h.resolved_at AS handoff_resolved_at,
      rh.status AS reviewer_status
    FROM lane_ledger l
    JOIN handoffs h ON l.implementer_handoff = h.handoff_id
    LEFT JOIN handoffs rh ON l.reviewer_handoff = rh.handoff_id
    WHERE l.gate_status = 'open'
      AND h.status IN ('completed', 'failed', 'rejected', 'expired')
      AND h.resolved_at IS NOT NULL
      AND MAX(h.resolved_at, l.ts_opened) <=
        CASE l.task_class WHEN 'TRIVIAL' THEN ? ELSE ? END
  `,
    )
    .all(trivialCutoff, nonTrivialCutoff);

  const lane_ids: string[] = [];
  for (const row of rows) {
    if (
      row.reviewer_status &&
      !(TERMINAL_HANDOFF_STATUSES as readonly string[]).includes(row.reviewer_status)
    )
      continue;

    const grace_min = Math.round(
      (row.task_class === "TRIVIAL" ? trivialGraceMs : nonTrivialGraceMs) / 60_000,
    );
    const reason = `${ORPHAN_SWEEPER_REASON_PREFIX} implementer handoff ${row.handoff_status} since ${row.handoff_resolved_at ?? "unknown"}; lane was not closed within ${String(grace_min)}min grace window`;
    // Explicitly skip /memory-verify/authorize for sweeper auto-closes.
    // Human reviewer authorization is required for lane_close/dispatch_land provenance.
    // The reviewer non-terminal guard is re-evaluated INSIDE the transaction
    // (same db.transaction as closeLane) so a reviewer that transitions to
    // in-flight between the outer SELECT and the write cannot race past the
    // sweeper. If the reviewer is non-terminal at write time we abort.
    try {
      let aborted = false;
      services.db.transaction(() => {
        const liveReviewer = services.db
          .query<{ reviewer_handoff: string | null; reviewer_status: string | null }, [string]>(
            `
              SELECT l.reviewer_handoff, rh.status AS reviewer_status
              FROM lane_ledger l
              LEFT JOIN handoffs rh ON l.reviewer_handoff = rh.handoff_id
              WHERE l.lane_id = ?
            `,
          )
          .get(row.lane_id);
        const reviewerHandoff = liveReviewer?.reviewer_handoff ?? null;
        if (
          reviewerHandoff &&
          liveReviewer?.reviewer_status &&
          !(TERMINAL_HANDOFF_STATUSES as readonly string[]).includes(liveReviewer.reviewer_status)
        ) {
          aborted = true;
          return;
        }
        closeLaneWithLog(
          services.db,
          row.lane_id,
          {
            ts_closed: now_iso,
            gate_status: row.task_class === "TRIVIAL" ? "skipped" : "review_debt",
            reviewer_handoff: reviewerHandoff,
            override_reason: reason,
            metadata: {
              notes: `orphan-lane sweep on ${now_iso}; implementer ${row.implementer_handoff} ${row.handoff_status}`,
            },
          },
          services.log,
        );
      })();
      if (!((): boolean => aborted)()) lane_ids.push(row.lane_id);
    } catch (err) {
      services.log.warn(
        { lane_id: row.lane_id, err: String(err) },
        "orphan-lane sweep close failed",
      );
    }
  }

  if (lane_ids.length > 0) {
    recordSweepEvent(
      services,
      { scanned: rows.length, closed: lane_ids.length, lane_ids },
      now_iso,
      { trivialGraceMs, nonTrivialGraceMs },
    );
  }

  return { scanned: rows.length, closed: lane_ids.length, lane_ids };
}

function recordSweepEvent(
  services: Services,
  result: OrphanLanesSweepResult,
  now_iso: string,
  grace: { trivialGraceMs: number; nonTrivialGraceMs: number },
): void {
  services.t0Writer.write({
    event_id: services.uuid(),
    ts: now_iso,
    ingest_ts: now_iso,
    source: "daemon",
    source_detail: "orphan-lane-sweep",
    project_id: null,
    user_id: services.machineId.get(),
    machine_id: services.machineId.get(),
    session_id: null,
    event_type: "lane.orphan-swept",
    lane: "unknown",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    origin: null,
    payload_json: {
      lane_ids: result.lane_ids,
      trivial_grace_ms: grace.trivialGraceMs,
      non_trivial_grace_ms: grace.nonTrivialGraceMs,
      scanned: result.scanned,
    },
    payload_summary: `orphan-lane sweep closed ${String(result.closed)} of ${String(result.scanned)} candidates`,
  });
}

/** Schedules the sweep on a recurring interval. Returns a cancel function. */
export function startOrphanLanesSweeper(
  services: Services,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  const trivialGraceMs = services.settings.laneOrphanSweeperGraceMinutes * 60_000;
  const nonTrivialGraceMs = services.settings.laneOrphanSweeperNonTrivialGraceMinutes * 60_000;
  const timer = setInterval(() => {
    try {
      runOrphanLanesSweep(services, { trivialGraceMs, nonTrivialGraceMs });
    } catch (err) {
      services.log.warn({ err: String(err) }, "orphan-lane sweep failed");
    }
  }, intervalMs);
  maybeUnref(timer);
  return () => {
    clearInterval(timer);
  };
}
