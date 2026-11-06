import { DispatchEventKindSchema } from "@penumbra/api-contract";
import { z } from "zod";

import {
  type AttemptSlice,
  type FirstAttemptEligibility,
  firstAttemptEligibility,
  sliceHandoffAttempts,
  type SliceResult,
} from "./attempts.js";
import { taskDigest } from "./canonical.js";
import {
  buildLineages,
  type BuiltLineage,
  extractTaskRefs,
  type HelperKind,
  stripRetryStamp,
} from "./lineage.js";
import {
  AssistanceSchema,
  type Attempt,
  type EpisodeBody,
  IsoTsSchema,
  type ReceiptClaimBody,
  ReceiptClaimSchema,
} from "./manifest.js";

export const HandoffRowSchema = z.strictObject({
  handoff_id: z.string(),
  ts: IsoTsSchema,
  message: z.string(),
  parent_handoff_id: z.string().nullable(),
  triggered_by_event_id: z.string().nullable(),
  branch_base: z.string().nullable(),
  branch_name: z.string().nullable(),
  workflow_run_id: z.string().nullable(),
  dispatch_attempts: z.number().int().min(0),
});
export type HandoffRow = z.infer<typeof HandoffRowSchema>;

export const EventRowSchema = z.strictObject({
  id: z.number().int(),
  handoff_id: z.string(),
  worker_id: z.string().nullable(),
  source: z.enum(["worker", "daemon"]),
  kind: DispatchEventKindSchema,
  ts: IsoTsSchema,
  meta_json: z.string().nullable(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

export const IngestRowsSchema = z.strictObject({
  schema_version: z.literal(1),
  handoffs: z.array(HandoffRowSchema),
  events: z.array(EventRowSchema),
  retry_events: z
    .array(z.strictObject({ event_id: z.string(), handoff_id: z.string() }))
    .default([]),
  lanes: z
    .array(
      z.strictObject({
        lane_id: z.string(),
        implementer_handoff: z.string(),
        gate_status: z.string(),
        ts_closed: z.string().nullable(),
      }),
    )
    .default([]),
});
export type IngestRows = z.infer<typeof IngestRowsSchema>;

type AttemptHistory = EpisodeBody["attempt_history"];
type Assistance = z.infer<typeof AssistanceSchema>;
type TaskRefs = ReturnType<typeof extractTaskRefs>;

export interface RowEpisode {
  lineage: {
    root_handoff_id: string;
    handoff_ids: string[];
    shape: BuiltLineage["shape"];
  };
  attempt_history: AttemptHistory;
  attempts: Attempt[];
  assistance: Assistance[];
  labels: Record<string, string>;
  effective_models: ({ attempt_n: number } & AttemptSlice["effective_model"])[];
  tool_failures: { attempt_n: number; count: number }[];
  receipts: ReceiptClaimBody[];
  final_sha: string | null;
  task_digest: string;
  task_refs: TaskRefs;
  first_attempt: FirstAttemptEligibility;
}

export interface IngestRowsResult {
  episodes: RowEpisode[];
  report: {
    excluded: { helper_check_verifier: number; helper_rubric_grader: number };
    helpers: { handoff_id: string; kind: HelperKind }[];
    lineages: number;
    orphan_events_dropped: number;
  };
}

function sliceLineage(
  lineage: BuiltLineage,
  handoffsById: ReadonlyMap<string, HandoffRow>,
  eventsByHandoff: ReadonlyMap<string, readonly EventRow[]>,
  opts: { now: number; retentionDays: number },
): { slices: SliceResult[]; orphanEventsDropped: number } {
  const slices: SliceResult[] = [];
  let orphanEventsDropped = 0;
  let next = 1;
  for (const handoffId of lineage.handoff_ids) {
    const handoff = handoffsById.get(handoffId);
    if (handoff === undefined) continue;
    const result = sliceHandoffAttempts(handoff, eventsByHandoff.get(handoffId) ?? [], {
      now: opts.now,
      retentionDays: opts.retentionDays,
      startN: next,
    });
    orphanEventsDropped += result.orphan_events_dropped;
    slices.push(result);
    const last = result.attempts.at(-1);
    next = last === undefined ? next + (result.history.count ?? 0) : last.attempt.n + 1;
  }
  return { slices, orphanEventsDropped };
}

function mergeHistory(slices: readonly SliceResult[]): {
  history: AttemptHistory;
  kept: AttemptSlice[];
} {
  const unavailable = slices.find((slice) => slice.history.status === "unavailable");
  if (unavailable !== undefined) {
    return { history: unavailable.history, kept: [] };
  }
  const kept = slices.flatMap((slice) => slice.attempts);
  if (slices.some((slice) => slice.history.status === "partial")) {
    const count = slices.reduce(
      (sum, slice) => sum + (slice.history.count ?? slice.attempts.length),
      0,
    );
    return {
      history: {
        status: "partial",
        reason: "claims_pruned",
        count,
        count_basis: "handoff_counter",
      },
      kept,
    };
  }
  return {
    history: { status: "complete", reason: null, count: kept.length, count_basis: "claim_events" },
    kept,
  };
}

function compareLaneIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function laneReceipts(rows: IngestRows, memberIds: ReadonlySet<string>): ReceiptClaimBody[] {
  const lanes = rows.lanes
    .filter((lane) => memberIds.has(lane.implementer_handoff))
    .sort((a, b) => compareLaneIds(a.lane_id, b.lane_id));
  return lanes.map((lane) =>
    ReceiptClaimSchema.parse({
      kind: "lane_gate",
      sha: null,
      producer: "lane_ledger",
      claimed_verdict:
        lane.gate_status === "passed" ? "pass" : lane.gate_status === "failed" ? "fail" : "unknown",
      fail_reason: null,
      assertion_set_digest: null,
      grader_build: null,
      per_check: null,
      control_verdict: null,
      receipt_digest: null,
    }),
  );
}

function buildEpisode(
  lineage: BuiltLineage,
  history: AttemptHistory,
  kept: readonly AttemptSlice[],
  handoffsById: ReadonlyMap<string, HandoffRow>,
  rows: IngestRows,
): RowEpisode {
  const root = handoffsById.get(lineage.root_handoff_id);
  if (root === undefined) {
    throw new Error(`lineage root ${lineage.root_handoff_id} missing from handoffs`);
  }
  const memberIds = new Set(lineage.handoff_ids);
  const attempts = kept.map((slice) => slice.attempt);
  const assistance: Assistance[] = lineage.assistance.map((entry) => ({ ...entry }));
  return {
    lineage: {
      root_handoff_id: lineage.root_handoff_id,
      handoff_ids: [...lineage.handoff_ids],
      shape: lineage.shape,
    },
    attempt_history: history,
    attempts,
    assistance,
    labels: { ...lineage.labels },
    effective_models: kept.map((slice) => ({
      attempt_n: slice.attempt.n,
      ...slice.effective_model,
    })),
    tool_failures: kept.map((slice) => ({
      attempt_n: slice.attempt.n,
      count: slice.tool_failure_count,
    })),
    receipts: laneReceipts(rows, memberIds),
    final_sha: kept.at(-1)?.attempt.head_sha ?? null,
    task_digest: taskDigest(stripRetryStamp(root.message)),
    task_refs: extractTaskRefs(root.message, lineage.branch_names),
    first_attempt: firstAttemptEligibility({
      attempt_history: history,
      lineage,
      attempts,
      assistance,
    }),
  };
}

export function ingestRows(
  rows: IngestRows,
  opts: { now: number; retentionDays: number },
): IngestRowsResult {
  const retryEvents = new Map(rows.retry_events.map((event) => [event.event_id, event.handoff_id]));
  const { lineages, helpers } = buildLineages(rows.handoffs, { retryEvents });

  const handoffsById = new Map(rows.handoffs.map((handoff) => [handoff.handoff_id, handoff]));
  const eventsByHandoff = new Map<string, EventRow[]>();
  for (const event of rows.events) {
    const bucket = eventsByHandoff.get(event.handoff_id);
    if (bucket === undefined) {
      eventsByHandoff.set(event.handoff_id, [event]);
    } else {
      bucket.push(event);
    }
  }

  const excluded = { helper_check_verifier: 0, helper_rubric_grader: 0 };
  for (const helper of helpers) {
    excluded[helper.kind] += 1;
  }

  const episodes: RowEpisode[] = [];
  let orphanEventsDropped = 0;
  for (const lineage of lineages) {
    const { slices, orphanEventsDropped: dropped } = sliceLineage(
      lineage,
      handoffsById,
      eventsByHandoff,
      opts,
    );
    orphanEventsDropped += dropped;
    const { history, kept } = mergeHistory(slices);
    episodes.push(buildEpisode(lineage, history, kept, handoffsById, rows));
  }

  return {
    episodes,
    report: {
      excluded,
      helpers,
      lineages: lineages.length,
      orphan_events_dropped: orphanEventsDropped,
    },
  };
}
