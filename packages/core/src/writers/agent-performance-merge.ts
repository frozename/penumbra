import {
  AGENT_PERFORMANCE_RESERVED_METADATA_KEYS,
  type AgentPerformanceInput,
  type AgentPerformanceRow,
  type AgentPerformanceSource,
  type AgentPerformanceUpsertOptions,
  DEFAULT_AGENT_KIND,
  FULL_GIT_SHA_RE,
  RECONCILER_OWNED_METADATA_KEYS,
  WORKER_OWNED_METADATA_KEYS,
} from "../schemas/agent-performance.js";

// Attempt-scoped evidence: a no-observation write keeps the stored value, an
// explicit value (including 'n' and 0) replaces it, a new attempt resets it.
const KA_COLUMNS = [
  "rounds",
  "smoke_pass",
  "reviewer_findings",
  "maestro_score",
  "latency_ms",
  "exec_ms",
  "framework_overhead_ms",
  "artifact_present",
  "worktree_changed",
  "empty_response",
] as const satisfies readonly (keyof AgentPerformanceRow)[];

// Sticky classifications: kept within the attempt, reset by a new one.
const SL_COLUMNS = [
  "reliability_status",
  "maestro_takeover_required",
] as const satisfies readonly (keyof AgentPerformanceRow)[];

type MetadataObject = Record<string, unknown>;

type HeadScope = {
  verification_present: AgentPerformanceRow["verification_present"];
  trust_score: AgentPerformanceRow["trust_score"];
  khHead: string | null;
};

function parseMetadataObject(json: string): MetadataObject | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as MetadataObject)
      : null;
  } catch {
    return null;
  }
}

function isNonnegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function attemptOfMetadata(json: string): number | null {
  const value = parseMetadataObject(json)?.dispatch_attempt;
  return isNonnegativeInt(value) ? value : null;
}

function incomingAttempt(opts: AgentPerformanceUpsertOptions): number | null {
  const value = opts.identity?.dispatch_attempt;
  return isNonnegativeInt(value) ? value : null;
}

function sameAttempt(s: number | null, i: number | null): boolean {
  return s !== null && s === i;
}

function newAttempt(s: number | null, i: number | null): boolean {
  return s !== null && i !== null && i > s;
}

function staleAttempt(s: number | null, i: number | null): boolean {
  return s !== null && i !== null && i < s;
}

function headOf(opts: AgentPerformanceUpsertOptions): string | null {
  const head = opts.identity?.head_sha;
  return typeof head === "string" && FULL_GIT_SHA_RE.test(head) ? head : null;
}

// Head-scoped evidence: a KH value is recorded only beside a valid full head
// claim; a write carrying one without a head has both values dropped.
function headScoped(incoming: AgentPerformanceInput, head: string | null): HeadScope {
  const hasKh =
    (incoming.verification_present ?? null) !== null || (incoming.trust_score ?? null) !== null;
  if (!hasKh) {
    return {
      verification_present: incoming.verification_present,
      trust_score: incoming.trust_score,
      khHead: null,
    };
  }
  if (head === null) return { verification_present: null, trust_score: null, khHead: null };
  return {
    verification_present: incoming.verification_present,
    trust_score: incoming.trust_score,
    khHead: head,
  };
}

function sameHead(storedHead: unknown, khHead: string | null): boolean {
  return khHead === null || khHead === storedHead;
}

function isAuthoritative(
  incoming: AgentPerformanceInput,
  opts: AgentPerformanceUpsertOptions,
): boolean {
  return (
    incoming.source === "operator" ||
    (incoming.source === "reconciler" &&
      incoming.outcome !== "no_changes" &&
      opts.outcomeNonAuthoritative !== true)
  );
}

function ownerOf(meta: MetadataObject, key: string): AgentPerformanceSource | undefined {
  const value = meta[key];
  return value === "worker" || value === "reconciler" || value === "operator" ? value : undefined;
}

function keepVerdict(storedOwner: AgentPerformanceSource | undefined, auth: boolean): boolean {
  return !auth && (storedOwner === "reconciler" || storedOwner === "operator");
}

function isQuotaOrResourceEnv(row: AgentPerformanceRow): boolean {
  return (
    row.environment_failure === "y" &&
    (row.failure_class === "quota" || row.failure_class === "resource")
  );
}

function environmentFailure(
  stored: AgentPerformanceRow,
  incoming: AgentPerformanceInput,
  keep: boolean,
): AgentPerformanceRow["environment_failure"] {
  if (isQuotaOrResourceEnv(stored) || isQuotaOrResourceEnv(incoming)) return "y";
  return (keep ? stored.environment_failure : incoming.environment_failure) ?? null;
}

// classifier_declined is worker-only: once the verdict belongs to the
// reconciler or the operator it is never carried from either side.
function failureClass(
  stored: AgentPerformanceRow,
  incoming: AgentPerformanceInput,
  verdictOwned: boolean,
): string | null {
  if (isQuotaOrResourceEnv(stored) && !isQuotaOrResourceEnv(incoming)) {
    return stored.failure_class ?? null;
  }
  const pick = (value: string | null | undefined): string | null =>
    verdictOwned && value === "classifier_declined" ? null : (value ?? null);
  return pick(incoming.failure_class) ?? pick(stored.failure_class);
}

function keepWithin<K extends keyof AgentPerformanceRow>(
  stored: AgentPerformanceRow | null,
  incoming: AgentPerformanceInput,
  cols: readonly K[],
): Pick<AgentPerformanceRow, K> {
  return Object.fromEntries(cols.map((c) => [c, incoming[c] ?? stored?.[c] ?? null])) as Pick<
    AgentPerformanceRow,
    K
  >;
}

function keepNote(
  stored: AgentPerformanceRow,
  incoming: AgentPerformanceInput,
  keep: boolean,
  storedNotesOwner: AgentPerformanceSource | undefined,
): { notes: string | null; held: boolean } {
  const held =
    (keep && stored.notes !== null) ||
    (incoming.notes === null && storedNotesOwner !== incoming.source);
  return { notes: held ? stored.notes : incoming.notes, held };
}

function outcomeOwner(
  prior: {
    outcome: AgentPerformanceRow["outcome"];
    owner: AgentPerformanceSource | undefined;
  } | null,
  incoming: AgentPerformanceInput,
  auth: boolean,
  keep: boolean,
): AgentPerformanceSource | undefined {
  if (keep) return prior?.owner;
  if (auth || incoming.source === "worker") return incoming.source;
  if (prior !== null && incoming.outcome === prior.outcome) return prior.owner;
  return undefined;
}

function baseMetadata(meta: MetadataObject, source: AgentPerformanceSource): MetadataObject {
  const owned: readonly string[] =
    source === "worker"
      ? WORKER_OWNED_METADATA_KEYS
      : source === "reconciler"
        ? RECONCILER_OWNED_METADATA_KEYS
        : [];
  const drop = new Set<string>([...AGENT_PERFORMANCE_RESERVED_METADATA_KEYS, ...owned]);
  return Object.fromEntries(Object.entries(meta).filter(([key]) => !drop.has(key)));
}

type StampContext = {
  attempt: number;
  khHead: string | null;
  storedHead: unknown;
  producers: MetadataObject;
  source: AgentPerformanceSource;
  ts: string;
  outcomeSource: AgentPerformanceSource | undefined;
  notesSource: AgentPerformanceSource | undefined;
  taskTypeSource: AgentPerformanceSource | undefined;
};

function stampMetadata(
  base: MetadataObject,
  incomingObj: MetadataObject,
  ctx: StampContext,
): string {
  const reserved = new Set<string>(AGENT_PERFORMANCE_RESERVED_METADATA_KEYS);
  const cleaned = Object.fromEntries(
    Object.entries(incomingObj).filter(([key, value]) => value !== null && !reserved.has(key)),
  );
  const out: MetadataObject = { ...base, ...cleaned, dispatch_attempt: ctx.attempt };
  const head = ctx.khHead ?? (typeof ctx.storedHead === "string" ? ctx.storedHead : undefined);
  if (head !== undefined) out.head_sha = head;
  out.producers = { ...ctx.producers, [ctx.source]: ctx.ts };
  if (ctx.outcomeSource !== undefined) out.outcome_source = ctx.outcomeSource;
  if (ctx.notesSource !== undefined) out.notes_source = ctx.notesSource;
  if (ctx.taskTypeSource !== undefined) out.task_type_source = ctx.taskTypeSource;
  return JSON.stringify(out);
}

function normalize(row: AgentPerformanceRow): AgentPerformanceRow {
  const deprecated = row as { reconcile_status?: string | null };
  return {
    ...row,
    gate_outcome: row.gate_outcome ?? null,
    exec_ms: row.exec_ms ?? null,
    framework_overhead_ms: row.framework_overhead_ms ?? null,
    reliability_status: row.reliability_status ?? null,
    failure_class: row.failure_class ?? null,
    artifact_present: row.artifact_present ?? null,
    verification_present: row.verification_present ?? null,
    maestro_takeover_required: row.maestro_takeover_required ?? null,
    empty_response: row.empty_response ?? null,
    worktree_changed: row.worktree_changed ?? null,
    reconcile_status: deprecated.reconcile_status ?? null,
    environment_failure: row.environment_failure ?? null,
    trust_score: row.trust_score ?? null,
    agent_kind: row.agent_kind ?? DEFAULT_AGENT_KIND,
  };
}

function replaceRow(
  stored: AgentPerformanceRow | null,
  inObj: MetadataObject | null,
  incoming: AgentPerformanceInput,
  opts: AgentPerformanceUpsertOptions,
  s: number | null,
  i: number | null,
): AgentPerformanceRow {
  const isNew = newAttempt(s, i);
  const stickySource = isNew ? null : stored;
  const sticky = {
    ...keepWithin(stickySource, incoming, SL_COLUMNS),
    failure_class: incoming.failure_class ?? stickySource?.failure_class ?? null,
    gate_outcome: stored?.gate_outcome ?? incoming.gate_outcome ?? null,
  };
  if (i === null || inObj === null) {
    return normalize({ ...incoming, ...sticky });
  }
  const kh = headScoped(incoming, headOf(opts));
  return normalize({
    ...incoming,
    ...sticky,
    verification_present: kh.verification_present ?? null,
    trust_score: kh.trust_score ?? null,
    metadata_json: stampMetadata({}, inObj, {
      attempt: i,
      khHead: kh.khHead,
      storedHead: undefined,
      producers: {},
      source: incoming.source,
      ts: incoming.ts,
      outcomeSource: outcomeOwner(null, incoming, isAuthoritative(incoming, opts), false),
      notesSource: incoming.source,
      taskTypeSource: incoming.source === "operator" ? "operator" : undefined,
    }),
  });
}

function mergeSameAttempt(
  stored: AgentPerformanceRow,
  inObj: MetadataObject,
  incoming: AgentPerformanceInput,
  opts: AgentPerformanceUpsertOptions,
  i: number,
): AgentPerformanceRow {
  const storedMeta = parseMetadataObject(stored.metadata_json) ?? {};
  const priorOwner = ownerOf(storedMeta, "outcome_source");
  const auth = isAuthoritative(incoming, opts);
  const keep = keepVerdict(priorOwner, auth);
  const kh = headScoped(incoming, headOf(opts));
  const khSame = sameHead(storedMeta.head_sha, kh.khHead);
  const storedNotesOwner = ownerOf(storedMeta, "notes_source");
  const note = keepNote(stored, incoming, keep, storedNotesOwner);
  const storedTaskTypeOwner = ownerOf(storedMeta, "task_type_source");
  const taskTypeFromStored =
    keep || (storedTaskTypeOwner === "operator" && incoming.source !== "operator");
  const outcomeSource = outcomeOwner(
    { outcome: stored.outcome, owner: priorOwner },
    incoming,
    auth,
    keep,
  );
  const producers =
    typeof storedMeta.producers === "object" &&
    storedMeta.producers !== null &&
    !Array.isArray(storedMeta.producers)
      ? (storedMeta.producers as MetadataObject)
      : {};
  return normalize({
    ...incoming,
    ...keepWithin(stored, incoming, KA_COLUMNS),
    ...keepWithin(stored, incoming, SL_COLUMNS),
    verification_present: khSame
      ? (kh.verification_present ?? stored.verification_present ?? null)
      : (kh.verification_present ?? null),
    trust_score: khSame ? (kh.trust_score ?? stored.trust_score ?? null) : (kh.trust_score ?? null),
    outcome: keep ? stored.outcome : incoming.outcome,
    task_type: taskTypeFromStored ? stored.task_type : incoming.task_type,
    environment_failure: environmentFailure(stored, incoming, keep),
    failure_class: failureClass(
      stored,
      incoming,
      outcomeSource === "reconciler" || outcomeSource === "operator",
    ),
    notes: note.notes,
    gate_outcome: stored.gate_outcome ?? null,
    metadata_json: stampMetadata(baseMetadata(storedMeta, incoming.source), inObj, {
      attempt: i,
      khHead: kh.khHead,
      storedHead: storedMeta.head_sha,
      producers,
      source: incoming.source,
      ts: incoming.ts,
      outcomeSource,
      notesSource: note.held ? storedNotesOwner : incoming.source,
      taskTypeSource: taskTypeFromStored
        ? storedTaskTypeOwner
        : incoming.source === "operator"
          ? "operator"
          : undefined,
    }),
  });
}

export function mergeAgentPerformance(
  stored: AgentPerformanceRow | null,
  incoming: AgentPerformanceInput,
  opts: AgentPerformanceUpsertOptions,
): AgentPerformanceRow {
  const inObj = parseMetadataObject(incoming.metadata_json);
  const i = inObj === null ? null : incomingAttempt(opts);
  const s = stored === null ? null : attemptOfMetadata(stored.metadata_json);
  if (stored !== null && staleAttempt(s, i)) return stored;
  if (stored !== null && i !== null && inObj !== null && sameAttempt(s, i)) {
    return mergeSameAttempt(stored, inObj, incoming, opts, i);
  }
  return replaceRow(stored, inObj, incoming, opts, s, i);
}
