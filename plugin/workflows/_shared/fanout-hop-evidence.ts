import type { Database } from "bun:sqlite";

import {
  buildDispatchAuditReport,
  ChainReader,
  dispatchAuditSourcesFromDb,
  type DispatchRecommendedAction,
  type DispatchReliabilityStatus,
} from "@penumbra/core";

export type FanoutHop = {
  handoff_id: string;
  status: string;
  branch_name: string | null;
  to_agent: string;
  branch_base: string | null;
  parent_handoff_id: string | null;
  created_ts: string;
  is_retry: boolean;
};

export type FanoutHopEvidence = {
  latest_handoff_id: string | null;
  hop_count: number | null;
  extra_hops: number | null;
  retry_prompt_count: number | null;
  hops_incomplete: boolean | null;
  hops: FanoutHop[] | null;
  branch_name: string | null;
  branch_base: string | null;
  parent_handoff_id: string | null;
  reliability_status: DispatchReliabilityStatus | null;
  reliability_trustworthy: boolean | null;
  reliability_action: DispatchRecommendedAction | null;
};

type HandoffEvidenceRow = {
  handoff_id: string;
  status: string;
  branch_name: string | null;
  to_agent: string;
  branch_base: string | null;
  parent_handoff_id: string | null;
  ts: string;
  message: string;
};

export function unknownFanoutHopEvidence(provisionalBranchName: string | null): FanoutHopEvidence {
  return {
    latest_handoff_id: null,
    hop_count: null,
    extra_hops: null,
    retry_prompt_count: null,
    hops_incomplete: null,
    hops: null,
    branch_name: provisionalBranchName,
    branch_base: null,
    parent_handoff_id: null,
    reliability_status: null,
    reliability_trustworthy: null,
    reliability_action: null,
  };
}

function readHandoffRows(db: Database, conversationId: string): HandoffEvidenceRow[] {
  return db
    .query<HandoffEvidenceRow, [string]>(
      `SELECT handoff_id, status, branch_name, to_agent, branch_base, parent_handoff_id, ts, message
       FROM handoffs
       WHERE conversation_id = ?
       ORDER BY ts ASC, handoff_id ASC`,
    )
    .all(conversationId);
}

function asPrompt(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const prompt = (payload as Record<string, unknown>).prompt;
  return typeof prompt === "string" ? prompt : null;
}

function countRetryPrompts(db: Database, conversationId: string): number {
  const reader = new ChainReader(db);
  return reader
    .getMessages(conversationId, ["user-prompt"])
    .filter((event) => asPrompt(event.payload)?.startsWith("[silent-failure-retry]") === true)
    .length;
}

function readReliability(
  db: Database,
  rootHandoffId: string,
): Pick<
  FanoutHopEvidence,
  "reliability_status" | "reliability_trustworthy" | "reliability_action"
> {
  try {
    const report = buildDispatchAuditReport(dispatchAuditSourcesFromDb(db), rootHandoffId);
    return {
      reliability_status: report?.status ?? null,
      reliability_trustworthy: report?.trustworthy ?? null,
      reliability_action: report?.recommended_action ?? null,
    };
  } catch {
    return {
      reliability_status: null,
      reliability_trustworthy: null,
      reliability_action: null,
    };
  }
}

function toHop(row: HandoffEvidenceRow): FanoutHop {
  return {
    handoff_id: row.handoff_id,
    status: row.status,
    branch_name: row.branch_name,
    to_agent: row.to_agent,
    branch_base: row.branch_base,
    parent_handoff_id: row.parent_handoff_id,
    created_ts: row.ts,
    is_retry: row.message.startsWith("[silent-failure-retry]"),
  };
}

export function readFanoutHopEvidence(
  db: Database,
  input: {
    conversationId: string;
    rootHandoffId: string;
    provisionalBranchName: string | null;
  },
): FanoutHopEvidence {
  const rows = readHandoffRows(db, input.conversationId);
  const hops = rows.map(toHop);
  const root = rows.find((row) => row.handoff_id === input.rootHandoffId) ?? null;
  const retryPromptCount = countRetryPrompts(db, input.conversationId);
  const retryHopCount = hops.filter((hop) => hop.is_retry).length;
  const reliability = readReliability(db, input.rootHandoffId);
  return {
    latest_handoff_id: rows.at(-1)?.handoff_id ?? null,
    hop_count: hops.length,
    extra_hops: Math.max(hops.length - 1, 0),
    retry_prompt_count: retryPromptCount,
    hops_incomplete: retryPromptCount > retryHopCount,
    hops,
    branch_name: root?.branch_name ?? input.provisionalBranchName,
    branch_base: root?.branch_base ?? null,
    parent_handoff_id: root?.parent_handoff_id ?? null,
    ...reliability,
  };
}
