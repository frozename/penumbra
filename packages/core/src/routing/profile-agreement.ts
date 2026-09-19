import type { Database } from "bun:sqlite";

import type { ReplayDependencies } from "./replay.js";

import { type AgentTaskType, AgentTaskTypeSchema } from "../schemas/agent-performance.js";
import { type RoutingTaskType, type TaskProfile, TaskProfileSchema } from "./schemas.js";
import {
  type JevProfileDiagnostics,
  ROUTER_SCORED_AXES,
  type RouterScoredAxis,
  type TaskProfileJudgeFallbackReason,
  type TaskProfileJudgeResult,
} from "./task-profile-judge.js";
import { profileTaskDeterministic, type TaskProfileHints } from "./task-profile.js";

export interface ProfileReplayRow {
  decisionId: string;
  handoffId: string;
  ts: string;
  role: string | null;
  chainTaskType: AgentTaskType | null;
  prompt: string;
  recordedProfile: TaskProfile;
}

export interface ProfileReplayRows {
  since: string;
  until: string;
  rows: ProfileReplayRow[];
  skippedUnreadable: number;
}

export interface ProfileAxisAgreement {
  axis: RouterScoredAxis;
  compared: number;
  agreed: number;
  agreementRate: number | null;
  meanAbsDelta: number | null;
  meanSignedDelta: number | null;
}

export interface ProfileAgreementRowResult {
  decisionId: string;
  source: TaskProfileJudgeResult["source"];
  fallbackReason?: string;
  /** Question ids the judge applied, when it reports diagnostics. */
  acceptedAxes?: string[];
  deltas: Partial<Record<RouterScoredAxis, number>> | null;
}

export interface ProfileAgreementReport {
  since: string;
  until: string;
  tolerance: number;
  totalRows: number;
  skippedUnreadable: number;
  inputDrift: number;
  judged: number;
  bySource: { jev: number; deterministic: number; llm: number };
  fallbackReasons: Partial<Record<TaskProfileJudgeFallbackReason, number>>;
  axes: ProfileAxisAgreement[];
  taskTypesExactMatch: { compared: number; agreed: number };
  /** Jev's primary_task_type answer vs the recorded profile's first task type. */
  primaryTaskTypeMatch: { compared: number; agreed: number };
  candidateConfidenceHistogram: number[];
  /** Per-question answer-confidence histograms, keyed by question id. */
  questionConfidenceHistogram: Record<string, number[]>;
  /** Per-question count of rows where that question carried the lowest confidence. */
  lowestConfidenceQuestionCounts: Record<string, number>;
  rows: ProfileAgreementRowResult[];
}

export interface FetchProfileReplayRowsOpts {
  since: string;
  until: string;
  limit?: number;
}

/**
 * Half of one step on the Jev five-level rubric (levels are 0, .25, .5, .75, 1):
 * a candidate axis within this distance of the recorded axis counts as agreement.
 */
export const DEFAULT_PROFILE_AGREEMENT_TOLERANCE = 0.125;

const DEFAULT_ROW_LIMIT = 500;
const CONFIDENCE_BUCKETS = 10;

interface RawRow {
  decision_id: string;
  ts: string;
  handoff_id: string;
  role: string | null;
  task_profile_json: string | null;
  chain_task_type: string | null;
  prompt: unknown;
}

/**
 * Reads routed decisions joined to the RAW dispatch prompt. handoffs.message is
 * recall-injected context, not what the router saw; the raw prompt lives in
 * t0_events.payload_json $.prompt via handoffs.triggered_by_event_id.
 */
export function fetchProfileReplayRows(
  db: Database,
  opts: FetchProfileReplayRowsOpts,
): ProfileReplayRows {
  const raw = db
    .query<RawRow, [string, string, number]>(
      `
      SELECT rd.decision_id, rd.ts, rd.handoff_id, rd.role, rd.task_profile_json,
             h.chain_task_type, json_extract(e.payload_json, '$.prompt') AS prompt
      FROM routing_decisions rd
      JOIN handoffs h ON h.handoff_id = rd.handoff_id
      JOIN t0_events e ON e.event_id = h.triggered_by_event_id
      WHERE rd.ts >= ? AND rd.ts <= ?
      ORDER BY rd.ts ASC LIMIT ?
      `,
    )
    .all(opts.since, opts.until, opts.limit ?? DEFAULT_ROW_LIMIT);

  const rows: ProfileReplayRow[] = [];
  let skippedUnreadable = 0;
  for (const row of raw) {
    if (typeof row.prompt !== "string" || row.task_profile_json === null) {
      skippedUnreadable++;
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.task_profile_json);
    } catch {
      skippedUnreadable++;
      continue;
    }
    const recordedProfile = TaskProfileSchema.safeParse(decoded);
    if (!recordedProfile.success) {
      skippedUnreadable++;
      continue;
    }
    let chainTaskType: AgentTaskType | null = null;
    if (row.chain_task_type !== null) {
      const parsed = AgentTaskTypeSchema.safeParse(row.chain_task_type);
      if (!parsed.success) {
        skippedUnreadable++;
        continue;
      }
      chainTaskType = parsed.data;
    }
    rows.push({
      decisionId: row.decision_id,
      handoffId: row.handoff_id,
      ts: row.ts,
      role: row.role,
      chainTaskType,
      prompt: row.prompt,
      recordedProfile: recordedProfile.data,
    });
  }
  return { since: opts.since, until: opts.until, rows, skippedUnreadable };
}

/**
 * True when the stored task_profile_json cannot be reproduced by running the
 * deterministic profiler over the recovered inputs — meaning the stored row was
 * written under different profiler code or different inputs and judging it
 * would compare a candidate against a stale recording.
 */
export function hasInputDrift(row: ProfileReplayRow): boolean {
  const recomputed = profileTaskDeterministic(row.prompt, row.role ?? undefined, replayHints(row));
  for (const axis of ROUTER_SCORED_AXES) {
    if (recomputed[axis] !== row.recordedProfile[axis]) return true;
  }
  if (!taskTypesEqual(recomputed.taskTypes, row.recordedProfile.taskTypes)) return true;
  return recomputed.confidence !== row.recordedProfile.confidence;
}

/**
 * Sequentially re-judges every non-drifted row through the supplied judge and
 * reports per-axis agreement against the recorded profile. Read-only; performs
 * no writes and no clock or RNG access.
 */
export async function replayTaskProfiles(
  fetched: ProfileReplayRows,
  deps: Required<Pick<ReplayDependencies, "judge">>,
  opts?: { tolerance?: number },
): Promise<ProfileAgreementReport> {
  const stats = new ProfileAgreementStats(opts?.tolerance ?? DEFAULT_PROFILE_AGREEMENT_TOLERANCE);
  for (const row of fetched.rows) {
    if (hasInputDrift(row)) {
      stats.drifted();
      continue;
    }
    const result = await deps.judge.profileTask(
      row.prompt,
      row.role ?? undefined,
      replayHints(row),
    );
    stats.record(row, result);
  }
  return stats.toReport(fetched);
}

/**
 * Builds the report a --live run would produce without calling any judge:
 * drift is still detected per row through the same accumulator, so the dry and
 * live report shapes cannot drift apart.
 */
export function dryRunProfileReport(fetched: ProfileReplayRows): ProfileAgreementReport {
  const stats = new ProfileAgreementStats(DEFAULT_PROFILE_AGREEMENT_TOLERANCE);
  for (const row of fetched.rows) {
    if (hasInputDrift(row)) stats.drifted();
  }
  return stats.toReport(fetched);
}

function replayHints(row: ProfileReplayRow): TaskProfileHints {
  return row.chainTaskType !== null ? { taskType: row.chainTaskType } : {};
}

function taskTypesEqual(a: RoutingTaskType[], b: RoutingTaskType[]): boolean {
  return a.length === b.length && a.every((taskType, index) => taskType === b[index]);
}

function roundDelta(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function confidenceBucket(confidence: number): number {
  return Math.min(CONFIDENCE_BUCKETS - 1, Math.floor(confidence * CONFIDENCE_BUCKETS));
}

interface AxisAccum {
  compared: number;
  agreed: number;
  sumAbs: number;
  sumSigned: number;
}

function zeroAxisAccum(): AxisAccum {
  return { compared: 0, agreed: 0, sumAbs: 0, sumSigned: 0 };
}

class ProfileAgreementStats {
  private readonly tolerance: number;
  private readonly axes: Record<RouterScoredAxis, AxisAccum> = {
    codingDemand: zeroAxisAccum(),
    reasoningDemand: zeroAxisAccum(),
    agenticDemand: zeroAxisAccum(),
    latencySensitivity: zeroAxisAccum(),
    costSensitivity: zeroAxisAccum(),
  };
  private readonly bySource = { jev: 0, deterministic: 0, llm: 0 };
  private readonly fallbackReasons: Partial<Record<TaskProfileJudgeFallbackReason, number>> = {};
  private readonly histogram = new Array<number>(CONFIDENCE_BUCKETS).fill(0);
  private readonly questionHistograms: Record<string, number[]> = {};
  private readonly lowestConfidenceQuestions: Record<string, number> = {};
  private readonly rows: ProfileAgreementRowResult[] = [];
  private readonly taskTypes = { compared: 0, agreed: 0 };
  private readonly primaryTaskType = { compared: 0, agreed: 0 };
  private inputDrift = 0;
  private judged = 0;

  constructor(tolerance: number) {
    this.tolerance = tolerance;
  }

  drifted(): void {
    this.inputDrift++;
  }

  record(row: ProfileReplayRow, result: TaskProfileJudgeResult): void {
    this.judged++;
    this.bySource[result.source]++;
    if (result.source === "deterministic") {
      // The fallback profile is a copy of the deterministic profile, which is
      // identical to the recording on non-drifted rows; comparing it would
      // inflate every axis to 100%.
      this.fallbackReasons[result.fallbackReason] =
        (this.fallbackReasons[result.fallbackReason] ?? 0) + 1;
      this.rows.push({
        decisionId: row.decisionId,
        source: result.source,
        fallbackReason: result.fallbackReason,
        deltas: null,
      });
      return;
    }

    // When the judge reports per-question diagnostics, only the answers it
    // actually applied are comparable — a rejected axis still carries the
    // deterministic base value, which would read as a tautological agreement.
    const diagnostics = result.source === "jev" ? result.diagnostics : undefined;
    const accepted = diagnostics === undefined ? null : new Set<string>(diagnostics.acceptedAxes);

    const deltas: Partial<Record<RouterScoredAxis, number>> = {};
    for (const axis of ROUTER_SCORED_AXES) {
      if (accepted !== null && !accepted.has(axis)) continue;
      const delta = roundDelta(result.profile[axis] - row.recordedProfile[axis]);
      deltas[axis] = delta;
      const accum = this.axes[axis];
      accum.compared++;
      accum.sumAbs += Math.abs(delta);
      accum.sumSigned += delta;
      if (Math.abs(delta) <= this.tolerance) accum.agreed++;
    }
    if (diagnostics !== undefined) this.recordDiagnostics(row, diagnostics);
    this.taskTypes.compared++;
    if (taskTypesEqual(result.profile.taskTypes, row.recordedProfile.taskTypes)) {
      this.taskTypes.agreed++;
    }
    this.histogram[confidenceBucket(result.profile.confidence)] =
      (this.histogram[confidenceBucket(result.profile.confidence)] ?? 0) + 1;
    this.rows.push({
      decisionId: row.decisionId,
      source: result.source,
      ...(diagnostics === undefined ? {} : { acceptedAxes: [...diagnostics.acceptedAxes] }),
      deltas,
    });
  }

  private recordDiagnostics(row: ProfileReplayRow, diagnostics: JevProfileDiagnostics): void {
    let lowestId: string | undefined;
    let lowestConfidence = Number.POSITIVE_INFINITY;
    for (const [questionId, confidence] of Object.entries(diagnostics.answerConfidence)) {
      const histogram =
        this.questionHistograms[questionId] ?? new Array<number>(CONFIDENCE_BUCKETS).fill(0);
      histogram[confidenceBucket(confidence)] = (histogram[confidenceBucket(confidence)] ?? 0) + 1;
      this.questionHistograms[questionId] = histogram;
      if (confidence < lowestConfidence) {
        lowestConfidence = confidence;
        lowestId = questionId;
      }
    }
    if (lowestId !== undefined) {
      this.lowestConfidenceQuestions[lowestId] =
        (this.lowestConfidenceQuestions[lowestId] ?? 0) + 1;
    }
    if (diagnostics.primaryTaskType !== undefined) {
      this.primaryTaskType.compared++;
      if (diagnostics.primaryTaskType === row.recordedProfile.taskTypes[0]) {
        this.primaryTaskType.agreed++;
      }
    }
  }

  toReport(fetched: ProfileReplayRows): ProfileAgreementReport {
    return {
      since: fetched.since,
      until: fetched.until,
      tolerance: this.tolerance,
      totalRows: fetched.rows.length + fetched.skippedUnreadable,
      skippedUnreadable: fetched.skippedUnreadable,
      inputDrift: this.inputDrift,
      judged: this.judged,
      bySource: { ...this.bySource },
      fallbackReasons: { ...this.fallbackReasons },
      axes: ROUTER_SCORED_AXES.map((axis) => {
        const accum = this.axes[axis];
        return {
          axis,
          compared: accum.compared,
          agreed: accum.agreed,
          agreementRate: accum.compared > 0 ? accum.agreed / accum.compared : null,
          meanAbsDelta: accum.compared > 0 ? roundDelta(accum.sumAbs / accum.compared) : null,
          meanSignedDelta: accum.compared > 0 ? roundDelta(accum.sumSigned / accum.compared) : null,
        };
      }),
      taskTypesExactMatch: { ...this.taskTypes },
      primaryTaskTypeMatch: { ...this.primaryTaskType },
      candidateConfidenceHistogram: [...this.histogram],
      questionConfidenceHistogram: Object.fromEntries(
        Object.entries(this.questionHistograms).map(([id, histogram]) => [id, [...histogram]]),
      ),
      lowestConfidenceQuestionCounts: { ...this.lowestConfidenceQuestions },
      rows: this.rows,
    };
  }
}
