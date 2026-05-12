import type { Database } from 'bun:sqlite';
import { recentLanes } from '../db/lane-ledger.js';
import { getAgentRecommendations } from './agent-recommend.js';
import { getMemoryEfficacyRecent } from './memory-efficacy.js';
import { readSubscriptionPressure, type PressureResult } from './subscription-pressure.js';

export interface QualityStatusInput {
  window_hours?: number;
  min_samples?: number;
}

export interface QualityStatusSnapshot {
  generated_at: string;
  lanes: {
    total: number;
    by_status: {
      passed: number;
      failed: number;
      skipped: number;
      review_debt: number;
      open: number;
    };
    by_class: {
      BOUNDARY: number;
      STANDARD: number;
      TRIVIAL: number;
    };
    last_close_at: string | null;
  } | null;
  adversarial: {
    runs_24h: number;
    success_24h: number;
    failure_24h: number;
    avg_latency_ms_24h: number | null;
    last_run_at: string | null;
  } | null;
  agent_recommendations: {
    BOUNDARY: ReturnType<typeof getAgentRecommendations>;
    STANDARD: ReturnType<typeof getAgentRecommendations>;
    TRIVIAL: ReturnType<typeof getAgentRecommendations>;
  } | null;
  memory_efficacy: ReturnType<typeof getMemoryEfficacyRecent> & { window_hours: number } | null;
  subscription_pressure: PressureResult | null;
  errors: string[];
}

export function qualityStatus(db: Database, input: QualityStatusInput = {}): QualityStatusSnapshot {
  const windowHours = input.window_hours ?? 24;
  const minSamples = input.min_samples ?? 3;
  const generatedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const errors: string[] = [];

  let lanes: QualityStatusSnapshot['lanes'] = null;
  try {
    const rows = recentLanes(db, { since_iso: cutoff }, 10_000);
    const byStatus = { passed: 0, failed: 0, skipped: 0, review_debt: 0, open: 0 };
    const byClass = { BOUNDARY: 0, STANDARD: 0, TRIVIAL: 0 };
    let lastCloseAt: string | null = null;
    for (const row of rows) {
      byStatus[row.gate_status] = (byStatus[row.gate_status] ?? 0) + 1;
      byClass[row.task_class] = (byClass[row.task_class] ?? 0) + 1;
      if (row.ts_closed && (lastCloseAt === null || row.ts_closed > lastCloseAt)) lastCloseAt = row.ts_closed;
    }
    lanes = { total: rows.length, by_status: byStatus, by_class: byClass, last_close_at: lastCloseAt };
  } catch (err) {
    errors.push(`lanes: ${messageOf(err)}`);
  }

  let adversarial: QualityStatusSnapshot['adversarial'] = null;
  try {
    const rows = db.query<{
      ts: string;
      latency_ms: number | null;
      payload_json: string;
    }, [string]>(
      `SELECT ts, latency_ms, payload_json
       FROM t0_events
       WHERE event_type = 'workflow.outcome'
         AND ts >= ?
         AND payload_json LIKE '%"workflow_name":"adversarial-review"%'
       ORDER BY ts DESC`,
    ).all(cutoff);

    let success = 0;
    let failure = 0;
    let latencyTotal = 0;
    let latencyCount = 0;
    let lastRunAt: string | null = null;

    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { outcome?: string };
      if (payload.outcome === 'success') success += 1;
      else if (payload.outcome === 'failure') failure += 1;
      if (row.latency_ms != null) {
        latencyTotal += row.latency_ms;
        latencyCount += 1;
      }
      if (lastRunAt === null) lastRunAt = row.ts;
    }

    adversarial = {
      runs_24h: rows.length,
      success_24h: success,
      failure_24h: failure,
      avg_latency_ms_24h: latencyCount > 0 ? latencyTotal / latencyCount : null,
      last_run_at: lastRunAt,
    };
  } catch (err) {
    errors.push(`adversarial: ${messageOf(err)}`);
  }

  let agentRecommendations: QualityStatusSnapshot['agent_recommendations'] = null;
  try {
    const filter = (rows: ReturnType<typeof getAgentRecommendations>) => rows.filter((row) => row.samples >= minSamples);
    agentRecommendations = {
      BOUNDARY: filter(getAgentRecommendations({ db, taskType: 'BOUNDARY', windowDays: windowHours / 24 })),
      STANDARD: filter(getAgentRecommendations({ db, taskType: 'STANDARD', windowDays: windowHours / 24 })),
      TRIVIAL: filter(getAgentRecommendations({ db, taskType: 'TRIVIAL', windowDays: windowHours / 24 })),
    };
  } catch (err) {
    errors.push(`agent_recommendations: ${messageOf(err)}`);
  }

  let memoryEfficacy: QualityStatusSnapshot['memory_efficacy'] = null;
  try {
    memoryEfficacy = {
      ...getMemoryEfficacyRecent(db, { sinceISO: cutoff }),
      window_hours: windowHours,
    };
  } catch (err) {
    errors.push(`memory_efficacy: ${messageOf(err)}`);
  }

  let subscriptionPressure: QualityStatusSnapshot['subscription_pressure'] = null;
  try {
    subscriptionPressure = readSubscriptionPressure(db);
  } catch (err) {
    errors.push(`subscription_pressure: ${messageOf(err)}`);
  }

  return {
    generated_at: generatedAt,
    lanes,
    adversarial,
    agent_recommendations: agentRecommendations,
    memory_efficacy: memoryEfficacy,
    subscription_pressure: subscriptionPressure,
    errors,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
