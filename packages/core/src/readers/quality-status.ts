import type { Database } from "bun:sqlite";
import { getMemoryEfficacyRecent } from "./memory-efficacy.js";
import { readSubscriptionPressure, type PressureResult } from "./subscription-pressure.js";
import { routeAgent, type RouteAgentInput } from "../services/agent-routing.js";
import type { AgentRecommendation } from "../services/agent-routing.js";

export interface QualityStatusInput {
  window_hours?: number;
  min_samples?: number;
  task_type?: string;
  now?: Date;
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
    window_hours: number;
    runs_window: number;
    success_window: number;
    failure_window: number;
    avg_latency_ms_window: number | null;
    last_run_at: string | null;
  } | null;
  agent_recommendations: {
    task_type: string;
    recent: AgentRecommendation[];
  } | null;
  memory_efficacy: (ReturnType<typeof getMemoryEfficacyRecent> & { window_hours: number }) | null;
  subscription_pressure: PressureResult | null;
  errors: string[]; // stable opaque codes, never raw error strings
}

export function qualityStatus(db: Database, input: QualityStatusInput = {}): QualityStatusSnapshot {
  const windowHours = input.window_hours ?? 24;
  const minSamples = input.min_samples ?? 3;
  const taskType = input.task_type ?? "implement_substantial";
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();
  const errors: string[] = [];

  let lanes: QualityStatusSnapshot["lanes"] = null;
  try {
    const rows = db
      .query<
        {
          gate_status: string;
          task_class: string;
          ts_closed: string | null;
        },
        [string]
      >(
        `SELECT gate_status, task_class, ts_closed
       FROM lane_ledger
       WHERE ts_opened >= ?`,
      )
      .all(cutoff);
    const byStatus = { passed: 0, failed: 0, skipped: 0, review_debt: 0, open: 0 };
    const byClass = { BOUNDARY: 0, STANDARD: 0, TRIVIAL: 0 };
    let lastCloseAt: string | null = null;
    for (const row of rows) {
      if (row.gate_status in byStatus) {
        byStatus[row.gate_status as keyof typeof byStatus] += 1;
      }
      if (row.task_class in byClass) {
        byClass[row.task_class as keyof typeof byClass] += 1;
      }
      if (row.ts_closed && (lastCloseAt === null || row.ts_closed > lastCloseAt))
        lastCloseAt = row.ts_closed;
    }
    lanes = {
      total: rows.length,
      by_status: byStatus,
      by_class: byClass,
      last_close_at: lastCloseAt,
    };
  } catch (err) {
    errors.push("lanes_failed");
  }

  let adversarial: QualityStatusSnapshot["adversarial"] = null;
  try {
    const rows = db
      .query<
        {
          ts: string;
          payload_latency: number | null;
          outcome: string | null;
        },
        [string]
      >(
        `SELECT ts,
              CAST(json_extract(payload_json, '$.latency_ms') AS INTEGER) AS payload_latency,
              json_extract(payload_json, '$.outcome') AS outcome
       FROM t0_events
       WHERE event_type = 'workflow.outcome'
         AND ts >= ?
         AND json_extract(payload_json, '$.workflow_name') = 'adversarial-review'
       ORDER BY ts DESC`,
      )
      .all(cutoff);

    let success = 0;
    let failure = 0;
    let latencyTotal = 0;
    let latencyCount = 0;
    let lastRunAt: string | null = null;

    for (const row of rows) {
      if (row.outcome === "success") success += 1;
      else if (row.outcome === "failure" || row.outcome === "failed") failure += 1;
      if (row.payload_latency != null) {
        latencyTotal += row.payload_latency;
        latencyCount += 1;
      }
      if (lastRunAt === null) lastRunAt = row.ts;
    }

    adversarial = {
      window_hours: windowHours,
      runs_window: rows.length,
      success_window: success,
      failure_window: failure,
      avg_latency_ms_window: latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : null,
      last_run_at: lastRunAt,
    };
  } catch (err) {
    errors.push("adversarial_failed");
  }

  let agentRecommendations: QualityStatusSnapshot["agent_recommendations"] = null;
  try {
    const route = routeAgent({
      db,
      detail: "summary",
      taskType: taskType as RouteAgentInput["taskType"],
      windowDays: windowHours / 24,
    });
    if (route.detail !== "summary")
      throw new Error("unexpected routeAgent detail for qualityStatus");
    const all: AgentRecommendation[] = route.recommendations;
    agentRecommendations = {
      task_type: taskType,
      recent: all.filter((row) => row.samples >= minSamples),
    };
  } catch (err) {
    errors.push("agent_recommendations_failed");
  }

  let memoryEfficacy: QualityStatusSnapshot["memory_efficacy"] = null;
  try {
    memoryEfficacy = {
      ...getMemoryEfficacyRecent(db, { sinceISO: cutoff }),
      window_hours: windowHours,
    };
  } catch (err) {
    errors.push("memory_efficacy_failed");
  }

  let subscriptionPressure: QualityStatusSnapshot["subscription_pressure"] = null;
  try {
    subscriptionPressure = readSubscriptionPressure(db);
  } catch (err) {
    errors.push("subscription_pressure_failed");
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
