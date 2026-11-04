import type { Database } from "bun:sqlite";

import { z } from "zod";

import type { HandoffRow } from "../schemas/handoff.js";

import { FULL_GIT_SHA_RE } from "../schemas/agent-performance.js";
import { aggregateHandoffUsage } from "../services/agent-performance-capture.js";
import { AssistanceSchema, LineageUsageSchema } from "./manifest.js";

export type LineageRow = Pick<
  HandoffRow,
  "handoff_id" | "ts" | "message" | "parent_handoff_id" | "triggered_by_event_id"
> & {
  branch_base?: string | null;
  branch_name?: string | null;
  workflow_run_id?: string | null;
};

export type HelperKind = "helper_check_verifier" | "helper_rubric_grader";

export type BuiltLineage = {
  root_handoff_id: string;
  handoff_ids: string[];
  shape: "single" | "chain" | "branching";
  assistance: z.infer<typeof AssistanceSchema>[];
  labels: Record<string, string>;
  start_ts: string;
  branch_names: string[];
};

type Assistance = z.infer<typeof AssistanceSchema>;
type LinkKind = "retry_child" | "chain_hop" | "fix_round";
type BuildLineagesOpts =
  | ReadonlyMap<string, string>
  | { retryEvents?: ReadonlyMap<string, string> };

const RETRY_STAMP_RE = /^\[silent-failure-retry\] retry_of=(\S+) prior_agent=\S+(?:\n|$)/;
const VERIFY_CHECK_BRANCH_RE = /^[a-z][a-z0-9-]{0,19}\/verify-check_[0-9a-z]{1,8}$/;
const RUBRIC_GRADE_BRANCH_RE = /^[a-z][a-z0-9-]{0,19}\/rubric-grade_[0-9a-z]{1,8}$/;
const CHECK_MARKER = "You are an independent CHECK verifier";
const RUBRIC_MARKER = "You are an independent rubric grader";

export function parseRetryOf(message: string): string | null {
  return RETRY_STAMP_RE.exec(message)?.[1] ?? null;
}

export function stripRetryStamp(message: string): string {
  if (!RETRY_STAMP_RE.test(message)) return message;
  const newline = message.indexOf("\n");
  const rest = newline === -1 ? "" : message.slice(newline + 1);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

export function classifyHelper(
  row: Pick<LineageRow, "branch_name" | "branch_base" | "message">,
): HelperKind | null {
  const branchName = row.branch_name ?? null;
  if (branchName !== null) {
    if (VERIFY_CHECK_BRANCH_RE.test(branchName)) return "helper_check_verifier";
    if (RUBRIC_GRADE_BRANCH_RE.test(branchName)) return "helper_rubric_grader";
  }
  const branchBase = row.branch_base ?? null;
  if (branchBase !== null && FULL_GIT_SHA_RE.test(branchBase)) {
    if (row.message.includes(CHECK_MARKER)) return "helper_check_verifier";
    if (row.message.includes(RUBRIC_MARKER)) return "helper_rubric_grader";
  }
  return null;
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function compareByTsThenId(
  a: { ts: string; handoff_id: string },
  b: { ts: string; handoff_id: string },
): number {
  const diff = Date.parse(a.ts) - Date.parse(b.ts);
  if (diff !== 0) return diff;
  return compareIds(a.handoff_id, b.handoff_id);
}

function isOptsRecord(
  opts: BuildLineagesOpts,
): opts is { retryEvents?: ReadonlyMap<string, string> } {
  return !(opts instanceof Map);
}

function resolveRetryEvents(opts?: BuildLineagesOpts): ReadonlyMap<string, string> {
  if (opts === undefined) return new Map();
  if (isOptsRecord(opts)) return opts.retryEvents ?? new Map();
  return opts;
}

type ParentLink = { parent: string | null; kind: LinkKind | null; conflict: boolean };

function parentLinkFor(
  row: LineageRow,
  byId: ReadonlyMap<string, LineageRow>,
  retryEvents: ReadonlyMap<string, string>,
): ParentLink {
  const linkable = (id: string | null | undefined): id is string =>
    id !== null && id !== undefined && id !== row.handoff_id && byId.has(id);
  const eventTarget =
    row.triggered_by_event_id !== null
      ? (retryEvents.get(row.triggered_by_event_id) ?? null)
      : null;
  const stamped = parseRetryOf(row.message);
  const stampedConflict = stamped !== null && stamped !== row.parent_handoff_id;
  const eventConflict =
    eventTarget !== null &&
    eventTarget !== row.parent_handoff_id &&
    (stamped === null || stamped !== eventTarget);
  const conflict = stampedConflict || eventConflict;

  if (linkable(row.parent_handoff_id)) {
    const kind: LinkKind = stamped !== null || eventTarget !== null ? "retry_child" : "chain_hop";
    return { parent: row.parent_handoff_id, kind, conflict };
  }
  if (stamped !== null) {
    if (linkable(stamped)) return { parent: stamped, kind: "retry_child", conflict };
    if (linkable(eventTarget)) return { parent: eventTarget, kind: "retry_child", conflict };
    return { parent: null, kind: null, conflict };
  }
  if (linkable(eventTarget)) return { parent: eventTarget, kind: "retry_child", conflict: false };
  return { parent: null, kind: null, conflict: false };
}

function breakCycles(parent: Map<string, string>, linkKind: Map<string, LinkKind>): void {
  const roots: string[] = [];
  for (const id of parent.keys()) {
    const seen = new Set<string>([id]);
    let cursor = parent.get(id);
    let revisited = false;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        revisited = true;
        break;
      }
      seen.add(cursor);
      cursor = parent.get(cursor);
    }
    if (revisited) roots.push(id);
  }
  for (const id of roots) {
    parent.delete(id);
    linkKind.delete(id);
  }
}

function collectOrphanSeeds(
  ordered: readonly LineageRow[],
  parent: ReadonlyMap<string, string>,
  byId: ReadonlyMap<string, LineageRow>,
): Map<string, Assistance> {
  const seeds = new Map<string, Assistance>();
  for (const row of ordered) {
    if (parent.has(row.handoff_id)) continue;
    const stamped = parseRetryOf(row.message);
    if (stamped !== null && !byId.has(stamped)) {
      seeds.set(row.handoff_id, { kind: "retry_child", attempt_n: 1, ref: stamped });
    }
  }
  return seeds;
}

function isDescendantOf(
  id: string,
  ancestor: string,
  parent: ReadonlyMap<string, string>,
): boolean {
  let cursor = parent.get(id);
  while (cursor !== undefined) {
    if (cursor === ancestor) return true;
    cursor = parent.get(cursor);
  }
  return false;
}

function sameWorkflowRun(p: LineageRow, candidate: LineageRow): boolean {
  const pRun = p.workflow_run_id ?? null;
  const cRun = candidate.workflow_run_id ?? null;
  return pRun === null || cRun === null || pRun === cRun;
}

function isSuccessorCandidate(
  p: LineageRow,
  candidate: LineageRow,
  base: string,
  parent: ReadonlyMap<string, string>,
): boolean {
  if (p.handoff_id === candidate.handoff_id) return false;
  if ((p.branch_name ?? null) !== base) return false;
  if (!(Date.parse(p.ts) < Date.parse(candidate.ts))) return false;
  if (!sameWorkflowRun(p, candidate)) return false;
  return !isDescendantOf(p.handoff_id, candidate.handoff_id, parent);
}

function successorFor(
  candidate: LineageRow,
  remaining: readonly LineageRow[],
  parent: ReadonlyMap<string, string>,
): string | null {
  const base = candidate.branch_base ?? null;
  if (base === null) return null;
  let best: LineageRow | null = null;
  for (const p of remaining) {
    if (!isSuccessorCandidate(p, candidate, base, parent)) continue;
    if (best === null || compareByTsThenId(p, best) > 0) best = p;
  }
  return best?.handoff_id ?? null;
}

function collectSuccessorLinks(
  ordered: readonly LineageRow[],
  remaining: readonly LineageRow[],
  parent: ReadonlyMap<string, string>,
  orphanSeeds: ReadonlyMap<string, Assistance>,
): Map<string, string> {
  const links = new Map<string, string>();
  for (const candidate of ordered) {
    if (parent.has(candidate.handoff_id)) continue;
    if (orphanSeeds.has(candidate.handoff_id)) continue;
    const predecessor = successorFor(candidate, remaining, parent);
    if (predecessor !== null) links.set(candidate.handoff_id, predecessor);
  }
  return links;
}

function buildChildren(parent: ReadonlyMap<string, string>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const [id, p] of parent) {
    const bucket = children.get(p);
    if (bucket === undefined) children.set(p, [id]);
    else bucket.push(id);
  }
  return children;
}

function collectMembers(rootId: string, children: ReadonlyMap<string, string[]>): Set<string> {
  const members = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const child of children.get(current) ?? []) {
      if (!members.has(child)) {
        members.add(child);
        stack.push(child);
      }
    }
  }
  return members;
}

function shapeFor(
  memberIds: readonly string[],
  children: ReadonlyMap<string, string[]>,
): BuiltLineage["shape"] {
  if (memberIds.length <= 1) return "single";
  const anyBranching = memberIds.some((id) => (children.get(id)?.length ?? 0) > 1);
  return anyBranching ? "branching" : "chain";
}

function buildLineage(
  root: LineageRow,
  members: ReadonlySet<string>,
  byId: ReadonlyMap<string, LineageRow>,
  parent: ReadonlyMap<string, string>,
  linkKind: ReadonlyMap<string, LinkKind>,
  orphanSeeds: ReadonlyMap<string, Assistance>,
  children: ReadonlyMap<string, string[]>,
  conflicts: ReadonlySet<string>,
): BuiltLineage {
  const rest = [...members]
    .filter((id) => id !== root.handoff_id)
    .map((id) => byId.get(id))
    .filter((entry): entry is LineageRow => entry !== undefined)
    .sort(compareByTsThenId);
  const handoffIds = [root.handoff_id, ...rest.map((entry) => entry.handoff_id)];

  const assistance: Assistance[] = [];
  const seed = orphanSeeds.get(root.handoff_id);
  if (seed !== undefined) assistance.push(seed);
  for (let index = 1; index < handoffIds.length; index += 1) {
    const id = handoffIds[index];
    const predecessor = id === undefined ? undefined : parent.get(id);
    const kind = id === undefined ? undefined : linkKind.get(id);
    if (predecessor === undefined || kind === undefined) continue;
    assistance.push({ kind, attempt_n: index + 1, ref: predecessor });
  }

  const branchNames = [
    ...new Set(
      [...members]
        .map((id) => byId.get(id)?.branch_name ?? null)
        .filter((name): name is string => name !== null),
    ),
  ].sort(compareIds);

  const labels: Record<string, string> = {};
  if ([...members].some((id) => conflicts.has(id))) {
    labels["retry_link_conflict"] = "true";
  }

  return {
    root_handoff_id: root.handoff_id,
    handoff_ids: handoffIds,
    shape: shapeFor(handoffIds, children),
    assistance,
    labels,
    start_ts: root.ts,
    branch_names: branchNames,
  };
}

export function buildLineages(
  rows: readonly LineageRow[],
  opts?: BuildLineagesOpts,
): {
  lineages: BuiltLineage[];
  helpers: { handoff_id: string; kind: HelperKind }[];
} {
  const retryEvents = resolveRetryEvents(opts);

  const helpers: { handoff_id: string; kind: HelperKind }[] = [];
  const remaining: LineageRow[] = [];
  for (const row of rows) {
    const kind = classifyHelper(row);
    if (kind !== null) helpers.push({ handoff_id: row.handoff_id, kind });
    else remaining.push(row);
  }
  helpers.sort((a, b) => compareIds(a.handoff_id, b.handoff_id));

  const byId = new Map(remaining.map((row) => [row.handoff_id, row]));
  const ordered = [...remaining].sort((a, b) => compareIds(a.handoff_id, b.handoff_id));

  const parent = new Map<string, string>();
  const linkKind = new Map<string, LinkKind>();
  const conflicts = new Set<string>();
  for (const row of ordered) {
    const link = parentLinkFor(row, byId, retryEvents);
    if (link.conflict) conflicts.add(row.handoff_id);
    if (link.parent !== null && link.kind !== null) {
      parent.set(row.handoff_id, link.parent);
      linkKind.set(row.handoff_id, link.kind);
    }
  }
  breakCycles(parent, linkKind);

  const orphanSeeds = collectOrphanSeeds(ordered, parent, byId);
  const successorLinks = collectSuccessorLinks(ordered, remaining, parent, orphanSeeds);
  for (const [id, predecessor] of successorLinks) {
    parent.set(id, predecessor);
    linkKind.set(id, "fix_round");
  }
  breakCycles(parent, linkKind);

  const children = buildChildren(parent);
  const rootRows = remaining.filter((row) => !parent.has(row.handoff_id)).sort(compareByTsThenId);

  const lineages = rootRows.map((root) =>
    buildLineage(
      root,
      collectMembers(root.handoff_id, children),
      byId,
      parent,
      linkKind,
      orphanSeeds,
      children,
      conflicts,
    ),
  );

  return { lineages, helpers };
}

export function lineageUsage(
  db: Database,
  lineage: Pick<BuiltLineage, "handoff_ids" | "start_ts">,
  opts: { now: number; t0RetentionDays: number },
): z.infer<typeof LineageUsageSchema> | null {
  const usages = lineage.handoff_ids.map((id) => aggregateHandoffUsage(db, id));

  const tokenValues = usages
    .map((usage) => usage.tokens_used)
    .filter((tokens): tokens is number => tokens !== null);
  const costValues = usages
    .map((usage) => usage.cost_usd)
    .filter((cost): cost is number => cost !== null);

  const tokens = tokenValues.length > 0 ? tokenValues.reduce((a, b) => a + b, 0) : null;
  const costUsd = costValues.length > 0 ? costValues.reduce((a, b) => a + b, 0) : null;
  const counted = usages.filter(
    (usage) => usage.tokens_used !== null || usage.cost_usd !== null,
  ).length;
  // LineageUsageSchema floors handoff_ids_counted at min(1), so a lineage with
  // zero counted handoffs has no honest usage block; null (the manifest's
  // lineage_usage is nullable) keeps the missingness explicit.
  if (counted === 0) return null;

  let incompleteReason: z.infer<typeof LineageUsageSchema>["incomplete_reason"] = null;
  if (opts.now - Date.parse(lineage.start_ts) > opts.t0RetentionDays * 86_400_000) {
    incompleteReason = "t0_retention_window";
  } else if (usages.some((usage) => usage.tokens_used === null)) {
    incompleteReason = "handoff_usage_missing";
  }

  return LineageUsageSchema.parse({
    tokens,
    cost_usd: costUsd,
    handoff_ids_counted: counted,
    complete: incompleteReason === null,
    incomplete_reason: incompleteReason,
  });
}

function captureGroups(pattern: RegExp, text: string): string[] {
  const values: string[] = [];
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const group = match[1];
    if (group !== undefined) values.push(group);
    match = pattern.exec(text);
  }
  return values;
}

export function extractTaskRefs(
  message: string,
  branchNames: readonly string[],
): { issues: number[]; bundle_ids: string[] } {
  const texts = [message, ...branchNames];
  const issuePatterns = [/#(\d+)/g, /issues?\/(\d+)/g, /issue-(\d+)/g];
  const bundlePattern = /(?<![a-z0-9])op-([a-z0-9-]{3,48})/g;

  const issues = new Set<number>();
  const bundles = new Set<string>();
  for (const text of texts) {
    for (const pattern of issuePatterns) {
      pattern.lastIndex = 0;
      for (const value of captureGroups(pattern, text)) issues.add(Number(value));
    }
    bundlePattern.lastIndex = 0;
    for (const value of captureGroups(bundlePattern, text)) bundles.add(value);
  }

  return {
    issues: [...issues].sort((a, b) => a - b),
    bundle_ids: [...bundles].sort(compareIds),
  };
}
