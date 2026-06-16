import type { Services } from "@penumbra/core";
import { closeLane } from "@penumbra/core";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_GRACE_MS = 120 * 60_000;

const TERMINAL_HANDOFF_STATUSES = ["completed", "failed", "rejected", "expired"] as const;

export interface RunOrphanLanesSweepOpts {
  graceMs?: number;
  nowIso?: string;
}

export interface OrphanLanesSweepResult {
  scanned: number;
  closed: number;
  lane_ids: string[];
}

/**
 * Closes lanes that are still gate_status='open' but whose implementer handoff
 * has been terminal (completed/failed) for longer than graceMs. Skips lanes
 * with an in-flight reviewer handoff (non-terminal reviewer = lane is still
 * being reviewed). Idempotent — SQL UPDATE WHERE gate_status='open' guards
 * against double-close.
 */
export function runOrphanLanesSweep(
  services: Services,
  opts: RunOrphanLanesSweepOpts = {},
): OrphanLanesSweepResult {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const now_iso = opts.nowIso ?? services.clock().toISOString();
  const cutoff_iso = new Date(Date.parse(now_iso) - graceMs).toISOString();

  const rows = services.db
    .query<
      {
        lane_id: string;
        implementer_handoff: string;
        reviewer_handoff: string | null;
        handoff_status: string;
        handoff_resolved_at: string | null;
        reviewer_status: string | null;
      },
      [string]
    >(
      `
    SELECT
      l.lane_id,
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
      AND h.resolved_at <= ?
  `,
    )
    .all(cutoff_iso);

  const lane_ids: string[] = [];
  for (const row of rows) {
    if (
      row.reviewer_status &&
      !(TERMINAL_HANDOFF_STATUSES as readonly string[]).includes(row.reviewer_status)
    )
      continue;

    const grace_min = Math.round(graceMs / 60_000);
    const reason = `auto-closed by orphan-lane sweeper: implementer handoff ${row.handoff_status} since ${row.handoff_resolved_at}; lane was not closed within ${grace_min}min grace window`;
    // Explicitly skip /memory-verify/authorize for sweeper auto-closes.
    // Human reviewer authorization is required for lane_close/dispatch_land provenance.
    // NOTE: There's a small race window between this read and the closeLane UPDATE
    // where a reviewer handoff could transition from terminal back to in-flight (or
    // vice versa). Tolerated for v1 — sweep runs every 5min and the daemon is single-process.
    try {
      services.db.transaction(() => {
        closeLane(services.db, row.lane_id, {
          ts_closed: now_iso,
          gate_status: "skipped",
          reviewer_handoff: row.reviewer_handoff,
          override_reason: reason,
          metadata: {
            notes: `orphan-lane sweep on ${now_iso}; implementer ${row.implementer_handoff} ${row.handoff_status}`,
          },
        });
      })();
      lane_ids.push(row.lane_id);
    } catch (err) {
      (services as any).log?.warn?.(
        { lane_id: row.lane_id, err: String(err) },
        "orphan-lane sweep close failed",
      );
    }
  }

  if (lane_ids.length > 0) {
    // TODO(maestro): remove this cast post-merge. The worktree's node_modules/@penumbra/core
    // symlinks to the home checkout, which won't have the new 'lane.orphan-swept' EventType
    // value until this branch lands on main. Once on main, services.t0Writer.write directly
    // accepts the typed event and this cast becomes dead code.
    const writeAudit = (
      services.t0Writer.write as unknown as (e: Record<string, unknown>) => void
    ).bind(services.t0Writer);
    writeAudit({
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
      payload_json: { lane_ids, grace_ms: graceMs, scanned: rows.length },
      payload_summary: `orphan-lane sweep closed ${lane_ids.length} of ${rows.length} candidates`,
    } as Record<string, unknown>);
  }

  return { scanned: rows.length, closed: lane_ids.length, lane_ids };
}

/** Schedules the sweep on a recurring interval. Returns a cancel function. */
export function startOrphanLanesSweeper(
  services: Services,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  const graceMs = services.settings.laneOrphanSweeperGraceMinutes * 60_000;
  const timer = setInterval(() => {
    try {
      runOrphanLanesSweep(services, { graceMs });
    } catch (err) {
      (services as any).log?.warn?.({ err: String(err) }, "orphan-lane sweep failed");
    }
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return () => clearInterval(timer);
}
