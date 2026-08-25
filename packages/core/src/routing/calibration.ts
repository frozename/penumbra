import type { Database } from "bun:sqlite";

// Deliberately does NOT write predicted_* columns onto agent_performance: its
// upsert (see writers/agent-performance.ts) overwrites most non-COALESCE
// columns on every reconcile, so a prediction stashed there would be clobbered
// the next time the same handoff_id reconciles. Predictions already live in
// routing_decisions (predicted_cost_usd, predicted_latency_ms); this module
// only reads the two tables and joins them in memory. No writes, ever.

export interface CalibrationMetricSummary {
  sampleCount: number;
  /** Simple arithmetic mean of actual/predicted across all valid samples in the window. */
  meanRatio: number | null;
  /**
   * Bounded EWMA of actual/predicted, oldest-to-newest. 1 means well-calibrated;
   * >1 means the router under-predicts this metric for this agent; <1 means it
   * over-predicts. Each sample ratio is clamped to [RATIO_MIN, RATIO_MAX]
   * before both aggregations; meanRatio is the raw mean of those clamped
   * samples, and ewmaRatio applies one final clamp after smoothing.
   */
  ewmaRatio: number | null;
}

export interface CalibrationReport {
  agentName: string;
  windowDays: number;
  since: string;
  until: string;
  cost: CalibrationMetricSummary;
  latency: CalibrationMetricSummary;
}

interface CalibrationPairRow {
  ts: string;
  predicted_cost_usd: number | null;
  predicted_latency_ms: number | null;
  actual_cost_usd: number | null;
  actual_latency_ms: number | null;
}

const EWMA_ALPHA = 0.3;
const RATIO_MIN = 0.05;
const RATIO_MAX = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure read: joins routing_decisions.predicted_* to agent_performance actuals
 * on handoff_id for the given agent over the trailing windowDays, and derives
 * a bounded EWMA calibration ratio per metric. `now` is required rather than
 * defaulted (see the repo-wide "no ambient clocks" scan in router.test.ts,
 * which covers every file under src/routing/) so this module stays as
 * deterministic and replayable as the rest of the router.
 */
export function computeCalibration(
  db: Database,
  agentName: string,
  windowDays: number,
  now: Date,
): CalibrationReport {
  const untilIso = now.toISOString();
  const sinceIso = new Date(now.getTime() - windowDays * MS_PER_DAY).toISOString();

  const rows = db
    .query<CalibrationPairRow, [string, string, string]>(
      `
      SELECT ap.ts                    AS ts,
             rd.predicted_cost_usd     AS predicted_cost_usd,
             rd.predicted_latency_ms   AS predicted_latency_ms,
             ap.cost_usd               AS actual_cost_usd,
             ap.latency_ms             AS actual_latency_ms
      FROM routing_decisions rd
      JOIN agent_performance ap ON ap.handoff_id = rd.handoff_id
      WHERE rd.selected_agent = ?
        AND rd.applied = 1
        AND rd.handoff_id IS NOT NULL
        AND ap.ts >= ?
        AND ap.ts <= ?
      ORDER BY ap.ts ASC
      `,
    )
    .all(agentName, sinceIso, untilIso);

  return {
    agentName,
    windowDays,
    since: sinceIso,
    until: untilIso,
    cost: summarizeMetric(
      rows,
      (row) => row.predicted_cost_usd,
      (row) => row.actual_cost_usd,
    ),
    latency: summarizeMetric(
      rows,
      (row) => row.predicted_latency_ms,
      (row) => row.actual_latency_ms,
    ),
  };
}

function summarizeMetric(
  rows: readonly CalibrationPairRow[],
  predicted: (row: CalibrationPairRow) => number | null,
  actual: (row: CalibrationPairRow) => number | null,
): CalibrationMetricSummary {
  const ratios: number[] = [];
  for (const row of rows) {
    const p = predicted(row);
    const a = actual(row);
    if (p === null || a === null) continue;
    if (!Number.isFinite(p) || !Number.isFinite(a) || p <= 0 || a < 0) continue;
    ratios.push(clamp(a / p, RATIO_MIN, RATIO_MAX));
  }

  const [firstRatio, ...remainingRatios] = ratios;
  if (firstRatio === undefined) {
    return { sampleCount: 0, meanRatio: null, ewmaRatio: null };
  }

  const meanRatio = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  const ewma = remainingRatios.reduce(
    (acc, ratio) => EWMA_ALPHA * ratio + (1 - EWMA_ALPHA) * acc,
    firstRatio,
  );

  return {
    sampleCount: ratios.length,
    meanRatio: round(meanRatio),
    ewmaRatio: round(clamp(ewma, RATIO_MIN, RATIO_MAX)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
