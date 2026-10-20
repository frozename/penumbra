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
  latest_reliability_status: DispatchReliabilityStatus | null;
  latest_reliability_trustworthy: boolean | null;
  latest_reliability_action: DispatchRecommendedAction | null;
};

type HandoffEvidenceRow = {
  handoff_id: string;
  status: string;
  branch_name: string | null;
  to_agent: string;
  branch_base: string | null;
  parent_handoff_id: string | null;
  root_handoff_id: string | null;
  triggered_by_event_id: string | null;
  ts: string;
  message: string;
};

type RetryPrompt = {
  eventId: string;
  retryOf: string;
};

type ReliabilityEvidence = {
  status: DispatchReliabilityStatus | null;
  trustworthy: boolean | null;
  action: DispatchRecommendedAction | null;
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
    latest_reliability_status: null,
    latest_reliability_trustworthy: null,
    latest_reliability_action: null,
  };
}

function readHandoffRows(db: Database, conversationId: string): HandoffEvidenceRow[] {
  return db
    .query<HandoffEvidenceRow, [string]>(
      `SELECT handoff_id, status, branch_name, to_agent, branch_base, parent_handoff_id,
              root_handoff_id, triggered_by_event_id, ts, message
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

function retryOf(prompt: string): string | null {
  const match = /^\[silent-failure-retry\] retry_of=(\S+) prior_agent=\S+(?:\n|$)/.exec(prompt);
  return match?.[1] ?? null;
}

function readRetryPrompts(db: Database, conversationId: string): RetryPrompt[] {
  const reader = new ChainReader(db);
  return reader.getMessages(conversationId, ["user-prompt"]).flatMap((event) => {
    const prompt = asPrompt(event.payload);
    const parent = prompt === null ? null : retryOf(prompt);
    return parent === null ? [] : [{ eventId: event.event_id, retryOf: parent }];
  });
}

function readReliability(db: Database, handoffId: string): ReliabilityEvidence {
  try {
    const report = buildDispatchAuditReport(dispatchAuditSourcesFromDb(db), handoffId);
    return {
      status: report?.status ?? null,
      trustworthy: report?.trustworthy ?? null,
      action: report?.recommended_action ?? null,
    };
  } catch {
    return { status: null, trustworthy: null, action: null };
  }
}

function toHop(row: HandoffEvidenceRow, retryPromptEventIds: ReadonlySet<string>): FanoutHop {
  return {
    handoff_id: row.handoff_id,
    status: row.status,
    branch_name: row.branch_name,
    to_agent: row.to_agent,
    branch_base: row.branch_base,
    parent_handoff_id: row.parent_handoff_id,
    created_ts: row.ts,
    is_retry:
      row.message.startsWith("[silent-failure-retry]") ||
      (row.triggered_by_event_id !== null && retryPromptEventIds.has(row.triggered_by_event_id)),
  };
}

function effectiveParents(
  rows: readonly HandoffEvidenceRow[],
  retryPromptByEventId: ReadonlyMap<string, string>,
): { parents: ReadonlyMap<string, string | null>; conflicts: ReadonlySet<string> } {
  const parents = new Map<string, string | null>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const retryParent =
      row.triggered_by_event_id === null
        ? null
        : (retryPromptByEventId.get(row.triggered_by_event_id) ?? null);
    if (
      row.parent_handoff_id !== null &&
      retryParent !== null &&
      row.parent_handoff_id !== retryParent
    ) {
      conflicts.add(row.handoff_id);
    }
    parents.set(row.handoff_id, row.parent_handoff_id ?? retryParent);
  }
  return { parents, conflicts };
}

function collectDescendantIds(
  rows: readonly HandoffEvidenceRow[],
  parents: ReadonlyMap<string, string | null>,
  rootHandoffId: string,
): Set<string> {
  const descendants = new Set([rootHandoffId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = parents.get(row.handoff_id) ?? null;
      if (!descendants.has(row.handoff_id) && parent !== null && descendants.has(parent)) {
        descendants.add(row.handoff_id);
        changed = true;
      }
    }
  }
  return descendants;
}

function descendantTips(
  descendantIds: ReadonlySet<string>,
  parents: ReadonlyMap<string, string | null>,
): string[] {
  const parentsWithChildren = new Set<string>();
  for (const id of descendantIds) {
    const parent = parents.get(id) ?? null;
    if (parent !== null && descendantIds.has(parent)) parentsWithChildren.add(parent);
  }
  return [...descendantIds].filter((id) => !parentsWithChildren.has(id));
}

function hasDescendantCycle(
  descendantIds: ReadonlySet<string>,
  parents: ReadonlyMap<string, string | null>,
): boolean {
  const visited = new Set<string>();
  for (const start of descendantIds) {
    const path = new Set<string>();
    let current: string | null = start;
    while (current !== null && descendantIds.has(current)) {
      if (path.has(current)) return true;
      if (visited.has(current)) break;
      path.add(current);
      current = parents.get(current) ?? null;
    }
    for (const id of path) visited.add(id);
  }
  return false;
}

function hasConflictingOwnership(
  descendantRows: readonly HandoffEvidenceRow[],
  parents: ReadonlyMap<string, string | null>,
): boolean {
  const establishedOwners = new Set(
    descendantRows.flatMap((row) => {
      const effectiveParent = parents.get(row.handoff_id) ?? null;
      const canonicalParentReplacesSelfOwnership =
        row.parent_handoff_id === null &&
        effectiveParent !== null &&
        row.root_handoff_id === row.handoff_id;
      return row.root_handoff_id === null || canonicalParentReplacesSelfOwnership
        ? []
        : [row.root_handoff_id];
    }),
  );
  return establishedOwners.size > 1;
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
  const root = rows.find((row) => row.handoff_id === input.rootHandoffId) ?? null;
  if (root === null) return unknownFanoutHopEvidence(input.provisionalBranchName);

  const retryPrompts = readRetryPrompts(db, input.conversationId);
  const retryPromptByEventId = new Map(
    retryPrompts.map((prompt) => [prompt.eventId, prompt.retryOf] as const),
  );
  const { parents, conflicts } = effectiveParents(rows, retryPromptByEventId);
  const descendantIds = collectDescendantIds(rows, parents, input.rootHandoffId);
  const descendantRows = rows.filter((row) => descendantIds.has(row.handoff_id));
  const retryEventIds = new Set(retryPrompts.map((prompt) => prompt.eventId));
  const hops = descendantRows.map((row) => toHop(row, retryEventIds));
  const scopedRetryPrompts = retryPrompts.filter((prompt) => descendantIds.has(prompt.retryOf));
  const retryPromptCount = scopedRetryPrompts.length;
  const scopedRetryEventIds = new Set(scopedRetryPrompts.map((prompt) => prompt.eventId));
  const matchedRetryPromptCount = descendantRows.filter(
    (row) =>
      row.triggered_by_event_id !== null && scopedRetryEventIds.has(row.triggered_by_event_id),
  ).length;
  const rootReliability = readReliability(db, input.rootHandoffId);
  const rootOwnsTree = root.root_handoff_id === input.rootHandoffId;
  const invalidOwnedRows = rootOwnsTree
    ? rows.some(
        (row) => row.root_handoff_id === input.rootHandoffId && !descendantIds.has(row.handoff_id),
      )
    : false;
  const hasConflictingDescendant = [...conflicts].some((id) => descendantIds.has(id));
  const descendantCycle = hasDescendantCycle(descendantIds, parents);
  const ownerIds = new Set(
    root.root_handoff_id === null
      ? []
      : rows
          .filter((row) => row.root_handoff_id === root.root_handoff_id)
          .map((row) => row.handoff_id),
  );
  const ownedCycle = hasDescendantCycle(ownerIds, parents);
  const conflictingOwnership = hasConflictingOwnership(descendantRows, parents);
  const tips = descendantTips(descendantIds, parents);
  const hopsIncomplete =
    retryPromptCount !== matchedRetryPromptCount ||
    invalidOwnedRows ||
    hasConflictingDescendant ||
    descendantCycle ||
    ownedCycle ||
    conflictingOwnership ||
    tips.length !== 1;
  const latestHandoffId = hopsIncomplete ? null : (tips[0] ?? null);
  const latestReliability =
    latestHandoffId === null
      ? { status: null, trustworthy: null, action: null }
      : latestHandoffId === input.rootHandoffId
        ? rootReliability
        : readReliability(db, latestHandoffId);
  return {
    latest_handoff_id: latestHandoffId,
    hop_count: hops.length,
    extra_hops: Math.max(hops.length - 1, 0),
    retry_prompt_count: retryPromptCount,
    hops_incomplete: hopsIncomplete,
    hops,
    branch_name: root.branch_name ?? input.provisionalBranchName,
    branch_base: root.branch_base,
    parent_handoff_id: root.parent_handoff_id,
    reliability_status: rootReliability.status,
    reliability_trustworthy: rootReliability.trustworthy,
    reliability_action: rootReliability.action,
    latest_reliability_status: latestReliability.status,
    latest_reliability_trustworthy: latestReliability.trustworthy,
    latest_reliability_action: latestReliability.action,
  };
}
