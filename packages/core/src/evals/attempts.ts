import { CommitIntegrityEvidenceSchema } from "@penumbra/api-contract";
import { z } from "zod";

import type { HandoffRow } from "../schemas/handoff.js";
import type { DispatchEventRow } from "../services/dispatch-event-log.js";

import { resolveWorkerHeadSha } from "../services/agent-performance-identity.js";
import { type Attempt, AttemptSchema, type EpisodeBody, ModelIdentitySchema } from "./manifest.js";

export type SliceHandoff = Pick<HandoffRow, "handoff_id" | "ts" | "dispatch_attempts">;

type EffectiveModel = z.infer<typeof ModelIdentitySchema.shape.effective>;

export type AttemptSlice = {
  attempt: Attempt;
  effective_model: EffectiveModel;
  tool_failure_count: number;
};

export type SliceResult = {
  history: EpisodeBody["attempt_history"];
  attempts: AttemptSlice[];
  orphan_events_dropped: number;
};

export type FirstAttemptEligibility = "eligible" | "ineligible" | "unknown";

function parseMeta(row: DispatchEventRow): Record<string, unknown> | null {
  if (!row.meta_json) return null;
  try {
    const parsed: unknown = JSON.parse(row.meta_json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function commitsFor(meta: Record<string, unknown> | null): Attempt["commits"] {
  if (meta?.autocommitted === true) {
    return {
      final_commit_attribution: "recovery" as const,
      attribution_basis: "dispatch_end_autocommitted" as const,
      autocommit_flag: true,
    };
  }
  return {
    final_commit_attribution: "unknown" as const,
    attribution_basis: "none" as const,
    autocommit_flag: null,
  };
}

function flagsFor(meta: Record<string, unknown> | null): Attempt["contract_flags"] {
  const parsed = CommitIntegrityEvidenceSchema.safeParse(meta?.commit_integrity);
  if (!parsed.success) {
    return {
      scope: "attempt" as const,
      source: "none" as const,
      base_not_ancestor: null,
      identity_mismatch: null,
    };
  }
  const data = parsed.data;
  const mismatchedTotal = data.mismatched_total;
  const mismatchValue =
    mismatchedTotal === null
      ? null
      : typeof mismatchedTotal === "number"
        ? mismatchedTotal > 0
        : data.mismatched_commits.length > 0;
  return {
    scope: "attempt" as const,
    source: "attempt_dispatch_end" as const,
    base_not_ancestor: data.base_is_ancestor ? false : true,
    identity_mismatch: mismatchValue,
  };
}

function modelFor(events: readonly DispatchEventRow[]): EffectiveModel {
  const relevantKinds = new Set([
    "acp.model_selected",
    "acp.model_unavailable",
    "acp.model_select_failed",
  ]);
  let lastEvent: DispatchEventRow | null = null;
  for (const event of events) {
    if (relevantKinds.has(event.kind)) {
      lastEvent = event;
    }
  }
  if (!lastEvent) {
    return { value: null, provenance: "unknown", missing_reason: "no_model_selection_event" };
  }
  const meta = parseMeta(lastEvent);
  if (lastEvent.kind === "acp.model_selected") {
    const model = meta?.model;
    if (typeof model === "string" && model.length > 0) {
      const setModelSent = meta?.set_model_sent;
      const provenance = setModelSent === false ? "acp_current" : "acp_selected";
      return { value: model, provenance };
    }
  }
  if (lastEvent.kind === "acp.model_unavailable" || lastEvent.kind === "acp.model_select_failed") {
    return { value: null, provenance: "unattested", missing_reason: lastEvent.kind };
  }
  return { value: null, provenance: "unknown", missing_reason: "no_model_selection_event" };
}

function historyFor(
  k: number,
  c: number,
  ts: string,
  now: number,
  retentionDays: number,
): EpisodeBody["attempt_history"] {
  if (k === 0) {
    const expired = now - Date.parse(ts) > retentionDays * 86_400_000;
    return {
      status: "unavailable",
      reason: expired ? "retention_window" : "events_absent",
      count: c > 0 ? c : null,
      count_basis: c > 0 ? "handoff_counter_lower_bound" : "unknown",
    };
  }
  if (c === 0) {
    const expired = now - Date.parse(ts) > retentionDays * 86_400_000;
    if (expired) {
      return {
        status: "unavailable",
        reason: "claims_pruned",
        count: null,
        count_basis: "unknown",
      };
    }
    return { status: "complete", reason: null, count: k, count_basis: "claim_events" };
  }
  if (c <= k) {
    return { status: "complete", reason: null, count: k, count_basis: "claim_events" };
  }
  return { status: "partial", reason: "claims_pruned", count: c, count_basis: "handoff_counter" };
}

function buildAttempt(handoffId: string, n: number): Attempt {
  const attempt: Attempt = {
    n,
    handoff_id: handoffId,
    dispatch_attempt: null,
    head_sha: null,
    commits: {
      final_commit_attribution: "unknown" as const,
      attribution_basis: "none" as const,
      autocommit_flag: null,
    },
    contract_flags: {
      scope: "attempt" as const,
      source: "none" as const,
      base_not_ancestor: null,
      identity_mismatch: null,
    },
    timings: { queue_ms: null, exec_ms: null, check_ms: null, e2e_ms: null },
    usage: {
      tokens: null,
      cost_usd: null,
      scope: "unknown" as const,
      missing_reason: "not_sliced",
    },
  };
  const parsed = AttemptSchema.safeParse(attempt);
  if (parsed.success) {
    return parsed.data;
  }
  return attempt;
}

// Splits the id-ordered events at each claim; events before the first claim
// belong to no attempt and are counted as orphans.
function claimSlices(sorted: readonly DispatchEventRow[]): {
  slices: DispatchEventRow[][];
  orphans: number;
} {
  const claimIndices: number[] = [];
  for (const [i, row] of sorted.entries()) {
    if (row.kind === "claim") claimIndices.push(i);
  }
  const slices = claimIndices.map((start, s) =>
    sorted.slice(start + 1, claimIndices[s + 1] ?? sorted.length),
  );
  return { slices, orphans: claimIndices[0] ?? 0 };
}

function sliceAttempt(
  handoffId: string,
  n: number,
  sliceEvents: readonly DispatchEventRow[],
): AttemptSlice {
  const lastEnd = sliceEvents.filter((e) => e.kind === "dispatch.end").at(-1);
  const meta = lastEnd ? parseMeta(lastEnd) : null;
  const attempt = buildAttempt(handoffId, n);
  attempt.head_sha = resolveWorkerHeadSha(meta);
  attempt.commits = commitsFor(meta);
  attempt.contract_flags = flagsFor(meta);
  return {
    attempt,
    effective_model: modelFor(sliceEvents),
    tool_failure_count: sliceEvents.filter((e) => e.kind === "agent.tool_call.failed").length,
  };
}

export function sliceHandoffAttempts(
  handoff: SliceHandoff,
  events: readonly DispatchEventRow[],
  opts: { now: number; retentionDays: number; startN?: number },
): SliceResult {
  const startN = opts.startN ?? 1;
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const { slices, orphans } = claimSlices(sorted);

  const k = slices.length;
  const c = handoff.dispatch_attempts;
  const history = historyFor(k, c, handoff.ts, opts.now, opts.retentionDays);
  if (history.status === "unavailable") {
    return { history, attempts: [], orphan_events_dropped: orphans };
  }

  // With pruned claims the surviving attempts are the last k of c.
  const firstN = k > 0 && c > k ? c - k + 1 : startN;
  const attempts = slices.map((slice, i) => sliceAttempt(handoff.handoff_id, firstN + i, slice));
  return { history, attempts, orphan_events_dropped: orphans };
}

export function firstAttemptEligibility(
  ep: Pick<EpisodeBody, "attempt_history" | "lineage" | "attempts" | "assistance">,
): FirstAttemptEligibility {
  if (ep.attempt_history.status !== "complete") {
    return "unknown";
  }
  if (ep.lineage.shape === "branching") {
    return "unknown";
  }
  if (ep.attempts.length === 0) {
    return "unknown";
  }
  if (ep.attempts.length > 1) {
    return "ineligible";
  }
  if (ep.assistance.length > 0) {
    return "ineligible";
  }
  return "eligible";
}
