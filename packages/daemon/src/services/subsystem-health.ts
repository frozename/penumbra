import type { Database } from "bun:sqlite";

import { DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES } from "../dreaming/config.js";

const PRIMARY_TIER = "primary";
export const DREAM_QUERY_REWRITE_SUBSYSTEM = "dream.query_rewrite";
export const DREAM_JUDGE_SUBSYSTEM_PREFIX = "dream.judge.";
// 5 is half of the default P1 batch (p1BatchSize 10), so a dead seat alerts
// within its first cycle.
const JUDGE_ABSTAIN_CONSECUTIVE_ALERT_THRESHOLD = 5;
const PERMANENT_FALLBACK_AFTER_MS = 6 * 60 * 60_000;
const QUERY_REWRITE_FAILURE_RATE_ALERT_THRESHOLD = 0.9;
// Post-rewrite unsearchable output is content degradation, not a seat-liveness failure.
const QUERY_REWRITE_UNSEARCHABLE_RATE_ALERT_THRESHOLD = 0.9;
const QUERY_REWRITE_CONSECUTIVE_FAILURES_ALERT_THRESHOLD = 3;
const QUERY_REWRITE_MIN_SAMPLE_ALERT_THRESHOLD = 5;

export interface LlmRoleFloorSpec {
  role: string;
  consumer: string;
  minimumHolders: number;
}

export interface LlmRoleFloorViolation {
  role: string;
  consumer: string;
  requiredHolders: number;
  actualHolders: number;
  holderNames: string[];
  reason?: string;
}

export interface LlmRoleFloorEvaluation {
  ok: boolean;
  violations: LlmRoleFloorViolation[];
}

interface LlmRoleAgent {
  name?: unknown;
  roles?: unknown;
}

interface LlmRoleAgentchatConfig {
  agents?: unknown;
}

export interface RecordSubsystemOutcomeInput {
  subsystem: string;
  tier: string;
  // "skip" is a neutral outcome: the seat answered but produced no rewrite, so it
  // must neither mask failures (success) nor count against the seat (failure).
  ok: boolean | "skip";
  ts?: Date | string;
  seat?: string | null;
  model?: string | null;
  host?: string | null;
  reason?: string | null;
  status?: number | null;
}

export interface SubsystemHealthRow {
  subsystem: string;
  tier: string;
  seat: string | null;
  model: string | null;
  host: string | null;
  consecutive_failures: number;
  last_success_ts: string | null;
  last_failure_ts: string | null;
  last_failure_reason: string | null;
  last_failure_status: number | null;
  first_non_primary_ts: string | null;
  last_skip_ts: string | null;
  updated_at: string;
}

export interface ComputeSubsystemAlertsOptions {
  now?: Date;
  healthRecencyWindowMs?: number;
  permanentFallbackAfterMs?: number;
  queryRewriteFailed24h?: number;
  queryRewriteSuccess24h?: number;
  queryRewriteFailedRecent?: number;
  queryRewriteRejected24h?: number;
  queryRewriteRejectedRecent?: number;
  queryRewriteFailureRateAlertThreshold?: number;
  queryRewriteUnsearchableRateAlertThreshold?: number;
  queryRewriteConsecutiveFailuresAlertThreshold?: number;
  queryRewriteMinSampleAlertThreshold?: number;
  judgeAbstainConsecutiveAlertThreshold?: number;
  requiredLlmRoleFloors?: LlmRoleFloorSpec[];
  agentchatConfig?: LlmRoleAgentchatConfig | null;
}

export interface BuildRequiredLlmRoleFloorsOptions {
  env?: Record<string, string | undefined>;
  dreamingAutoPromoteMinJudges?: number;
}

const ROLE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function envRole(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value !== undefined && ROLE_SLUG_RE.test(value) ? value : fallback;
}

function minimumHolders(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.ceil(value) : fallback;
}

export function buildRequiredLlmRoleFloors(
  opts: BuildRequiredLlmRoleFloorsOptions = {},
): LlmRoleFloorSpec[] {
  const env = opts.env ?? process.env;
  return [
    {
      role: envRole(env, "PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE", "brief-synthesizer"),
      consumer: "dreaming.brief_synthesizer",
      minimumHolders: 1,
    },
    {
      role: envRole(env, "PENUMBRA_JUDGE_ROLE", "memory-refiner"),
      consumer: "t2.promotion",
      minimumHolders: 1,
    },
    {
      role: envRole(env, "PENUMBRA_DREAMING_JUDGE_ROLE", "dreaming-judge"),
      consumer: "dreaming.p1_auto_promote",
      minimumHolders: minimumHolders(
        opts.dreamingAutoPromoteMinJudges,
        DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES,
      ),
    },
    {
      role: envRole(env, "PENUMBRA_DREAMING_REWRITER_ROLE", "dreaming-rewriter"),
      consumer: "dreaming.p4_query_rewrite",
      minimumHolders: 1,
    },
    {
      role: envRole(env, "PENUMBRA_REFINER_ROLE", "refiner"),
      consumer: "dispatch.refiner",
      minimumHolders: 1,
    },
  ];
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve LLM role-floor evaluation while grandfathering its pre-existing complexity.
export function evaluateLlmRoleFloors(input: {
  agentchatConfig?: LlmRoleAgentchatConfig | null;
  requiredRoles: LlmRoleFloorSpec[];
}): LlmRoleFloorEvaluation {
  const violations: LlmRoleFloorViolation[] = [];
  const agents = input.agentchatConfig?.agents;
  if (!Array.isArray(agents)) {
    return {
      ok: false,
      violations: input.requiredRoles.map((spec) => ({
        role: spec.role,
        consumer: spec.consumer,
        requiredHolders: spec.minimumHolders,
        actualHolders: 0,
        holderNames: [],
        reason: "unparseable_role_registry",
      })),
    };
  }

  const holdersByRole = new Map<string, string[]>();
  let unparseable = false;
  for (const rawAgent of agents as LlmRoleAgent[]) {
    const name = typeof rawAgent.name === "string" && rawAgent.name ? rawAgent.name : "unknown";
    if (!Array.isArray(rawAgent.roles)) {
      unparseable = true;
      continue;
    }
    for (const role of rawAgent.roles) {
      if (typeof role !== "string" || role.length === 0) {
        unparseable = true;
        continue;
      }
      const holders = holdersByRole.get(role) ?? [];
      holders.push(name);
      holdersByRole.set(role, holders);
    }
  }

  for (const spec of input.requiredRoles) {
    const holderNames = holdersByRole.get(spec.role) ?? [];
    if (unparseable || holderNames.length < spec.minimumHolders) {
      violations.push({
        role: spec.role,
        consumer: spec.consumer,
        requiredHolders: spec.minimumHolders,
        actualHolders: unparseable ? 0 : holderNames.length,
        holderNames: unparseable ? [] : holderNames,
        ...(unparseable ? { reason: "unparseable_role_registry" } : {}),
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// Percent-encoding the role keeps `.` out of its segment and keeps distinct
// roles distinct, so no role name can spell another role's alert ID.
function escapeAlertSegment(value: string): string {
  return value.replaceAll(/[^a-z0-9_-]/gu, (char) =>
    Buffer.from(char).toString("hex").replaceAll(/../g, "%$&"),
  );
}

function roleFloorAlert(violation: LlmRoleFloorViolation): string {
  return `llm.role_floor.${escapeAlertSegment(violation.role)}.required_${String(
    violation.requiredHolders,
  )}.actual_${String(violation.actualHolders)}`;
}

function normalizeTs(ts: Date | string | undefined): string {
  if (ts === undefined) return new Date().toISOString();
  return typeof ts === "string" ? ts : ts.toISOString();
}

function nextConsecutiveFailures(
  existing: SubsystemHealthRow | null,
  ok: boolean | "skip",
  isPrimary: boolean,
): number {
  const prior = existing?.consecutive_failures ?? 0;
  if (ok === "skip") return prior;
  if (ok) return isPrimary ? 0 : prior;
  return prior + 1;
}

function nextFirstNonPrimaryTs(
  existing: SubsystemHealthRow | null,
  ok: boolean | "skip",
  isPrimary: boolean,
  ts: string,
): string | null {
  // Only a primary success proves the primary rung is serving again: a primary
  // failure must not restart the permanent-fallback clock, and a skip is neutral
  // liveness that moves the clock in neither direction.
  if (ok === "skip") return existing?.first_non_primary_ts ?? null;
  if (isPrimary) return ok ? null : (existing?.first_non_primary_ts ?? null);
  return existing?.first_non_primary_ts ?? ts;
}

export function recordSubsystemOutcome(db: Database, input: RecordSubsystemOutcomeInput): void {
  const ts = normalizeTs(input.ts);
  const existing = readSubsystemHealth(db, input.subsystem);
  const isPrimary = input.tier === PRIMARY_TIER;
  const isSkip = input.ok === "skip";
  const succeeded = input.ok === true;
  const failed = !isSkip && !succeeded;
  const consecutiveFailures = nextConsecutiveFailures(existing, input.ok, isPrimary);
  const lastSuccessTs = isSkip
    ? (existing?.last_success_ts ?? null)
    : succeeded
      ? ts
      : (existing?.last_success_ts ?? null);
  const lastFailureTs = failed ? ts : (existing?.last_failure_ts ?? null);
  const lastFailureReason = failed
    ? (input.reason ?? null)
    : (existing?.last_failure_reason ?? null);
  const lastFailureStatus = failed
    ? (input.status ?? null)
    : (existing?.last_failure_status ?? null);
  const firstNonPrimaryTs = nextFirstNonPrimaryTs(existing, input.ok, isPrimary, ts);
  const lastSkipTs = isSkip ? ts : (existing?.last_skip_ts ?? null);

  db.run(
    `INSERT INTO subsystem_health (
       subsystem, tier, seat, model, host, consecutive_failures, last_success_ts,
       last_failure_ts, last_failure_reason, last_failure_status,
       first_non_primary_ts, last_skip_ts, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subsystem) DO UPDATE SET
       tier = excluded.tier,
       seat = excluded.seat,
       model = excluded.model,
       host = excluded.host,
       consecutive_failures = excluded.consecutive_failures,
       last_success_ts = excluded.last_success_ts,
       last_failure_ts = excluded.last_failure_ts,
       last_failure_reason = excluded.last_failure_reason,
       last_failure_status = excluded.last_failure_status,
       first_non_primary_ts = excluded.first_non_primary_ts,
       last_skip_ts = excluded.last_skip_ts,
       updated_at = excluded.updated_at`,
    [
      input.subsystem,
      input.tier,
      input.seat ?? null,
      input.model ?? null,
      input.host ?? null,
      consecutiveFailures,
      lastSuccessTs,
      lastFailureTs,
      lastFailureReason,
      lastFailureStatus,
      firstNonPrimaryTs,
      lastSkipTs,
      ts,
    ],
  );
}

export function readSubsystemHealth(db: Database, subsystem: string): SubsystemHealthRow | null {
  return (
    db
      .query<SubsystemHealthRow, [string]>(
        `SELECT subsystem, tier, seat, model, host, consecutive_failures,
                last_success_ts, last_failure_ts, last_failure_reason,
                last_failure_status, first_non_primary_ts, last_skip_ts, updated_at
         FROM subsystem_health
         WHERE subsystem = ?`,
      )
      .get(subsystem) ?? null
  );
}

function hasRewriteFailureAlert(input: {
  rewrite: SubsystemHealthRow | null;
  rewriteFailures: number;
  rewriteAttempts: number;
  rewriteFailuresRecent: number | undefined;
  rewriteFailureRate: number;
  rewriteFailureRateAlertThreshold: number;
  rewriteConsecutiveFailuresAlertThreshold: number;
  rewriteMinSampleAlertThreshold: number;
}): boolean {
  const rewriteVolumeFailure =
    input.rewriteFailures > 0 &&
    input.rewriteAttempts >= input.rewriteMinSampleAlertThreshold &&
    input.rewriteFailureRate >= input.rewriteFailureRateAlertThreshold &&
    (input.rewriteFailuresRecent === undefined || input.rewriteFailuresRecent > 0);
  const rewriteConsecutiveFailure =
    (input.rewrite?.consecutive_failures ?? 0) >= input.rewriteConsecutiveFailuresAlertThreshold;

  return rewriteVolumeFailure || rewriteConsecutiveFailure;
}

function hasRewriteUnsearchableAlert(input: {
  rewriteRejected: number;
  rewriteSearchabilityAttempts: number;
  rewriteRejectedRecent: number;
  rewriteUnsearchableRate: number;
  rewriteUnsearchableRateAlertThreshold: number;
  rewriteMinSampleAlertThreshold: number;
}): boolean {
  return (
    input.rewriteRejected > 0 &&
    input.rewriteSearchabilityAttempts >= input.rewriteMinSampleAlertThreshold &&
    input.rewriteRejectedRecent > 0 &&
    input.rewriteUnsearchableRate >= input.rewriteUnsearchableRateAlertThreshold
  );
}

function hasRewriteNoRecentSuccessAlert(input: {
  rewrite: SubsystemHealthRow | null;
  now: Date;
  healthRecencyWindowMs: number;
}): boolean {
  if (!input.rewrite?.last_failure_ts) return false;

  const lastFailureMs = Date.parse(input.rewrite.last_failure_ts);
  if (!Number.isFinite(lastFailureMs)) return false;

  const windowStartMs = input.now.getTime() - input.healthRecencyWindowMs;
  if (lastFailureMs < windowStartMs) return false;

  if (input.rewrite.last_success_ts === null) return true;

  const lastSuccessMs = Date.parse(input.rewrite.last_success_ts);
  return Number.isFinite(lastSuccessMs) && lastSuccessMs < windowStartMs;
}

function hasPermanentFallbackAlert(input: {
  rewrite: SubsystemHealthRow | null;
  now: Date;
  permanentFallbackAfterMs: number;
}): boolean {
  if (
    input.rewrite?.tier !== undefined &&
    input.rewrite.tier !== PRIMARY_TIER &&
    input.rewrite.first_non_primary_ts !== null
  ) {
    const firstNonPrimaryMs = Date.parse(input.rewrite.first_non_primary_ts);
    return (
      Number.isFinite(firstNonPrimaryMs) &&
      input.now.getTime() - firstNonPrimaryMs >= input.permanentFallbackAfterMs
    );
  }

  return false;
}

function judgeAbstainingAlerts(
  db: Database,
  opts: ComputeSubsystemAlertsOptions,
  now: Date,
  healthRecencyWindowMs: number,
): string[] {
  const threshold =
    opts.judgeAbstainConsecutiveAlertThreshold ?? JUDGE_ABSTAIN_CONSECUTIVE_ALERT_THRESHOLD;
  const windowStartMs = now.getTime() - healthRecencyWindowMs;
  const rows = db
    .query<
      { subsystem: string; consecutive_failures: number; last_failure_ts: string | null },
      [number, string]
    >(
      `SELECT subsystem, consecutive_failures, last_failure_ts
         FROM subsystem_health
        WHERE substr(subsystem, 1, ?) = ?
        ORDER BY subsystem`,
    )
    .all(DREAM_JUDGE_SUBSYSTEM_PREFIX.length, DREAM_JUDGE_SUBSYSTEM_PREFIX);
  return rows
    .filter((row) => {
      if (row.consecutive_failures < threshold || row.last_failure_ts === null) return false;
      const lastFailureMs = Date.parse(row.last_failure_ts);
      return Number.isFinite(lastFailureMs) && lastFailureMs >= windowStartMs;
    })
    .map(
      (row) =>
        `dream.health.judge_abstaining.${row.subsystem.slice(DREAM_JUDGE_SUBSYSTEM_PREFIX.length)}`,
    );
}

export function computeSubsystemAlerts(
  db: Database,
  opts: ComputeSubsystemAlertsOptions = {},
): string[] {
  const alerts: string[] = [];
  const now = opts.now ?? new Date();
  const healthRecencyWindowMs = opts.healthRecencyWindowMs ?? 6 * 60 * 60 * 1000;
  const permanentFallbackAfterMs = opts.permanentFallbackAfterMs ?? PERMANENT_FALLBACK_AFTER_MS;
  const rewriteFailures = opts.queryRewriteFailed24h ?? 0;
  const rewriteSuccesses = opts.queryRewriteSuccess24h ?? 0;
  const rewriteFailuresRecent = opts.queryRewriteFailedRecent;
  const rewriteRejected = opts.queryRewriteRejected24h ?? 0;
  const rewriteRejectedRecent = opts.queryRewriteRejectedRecent ?? 0;
  const rewriteAttempts = rewriteFailures + rewriteSuccesses;
  const rewriteFailureRate = rewriteAttempts > 0 ? rewriteFailures / rewriteAttempts : 0;
  const rewriteSearchabilityAttempts = rewriteRejected + rewriteSuccesses;
  const rewriteUnsearchableRate =
    rewriteSearchabilityAttempts > 0 ? rewriteRejected / rewriteSearchabilityAttempts : 0;
  const rewriteFailureRateAlertThreshold =
    opts.queryRewriteFailureRateAlertThreshold ?? QUERY_REWRITE_FAILURE_RATE_ALERT_THRESHOLD;
  const rewriteUnsearchableRateAlertThreshold =
    opts.queryRewriteUnsearchableRateAlertThreshold ??
    QUERY_REWRITE_UNSEARCHABLE_RATE_ALERT_THRESHOLD;
  const rewriteConsecutiveFailuresAlertThreshold =
    opts.queryRewriteConsecutiveFailuresAlertThreshold ??
    QUERY_REWRITE_CONSECUTIVE_FAILURES_ALERT_THRESHOLD;
  const rewriteMinSampleAlertThreshold =
    opts.queryRewriteMinSampleAlertThreshold ?? QUERY_REWRITE_MIN_SAMPLE_ALERT_THRESHOLD;
  const rewrite = readSubsystemHealth(db, DREAM_QUERY_REWRITE_SUBSYSTEM);

  if (
    hasRewriteFailureAlert({
      rewrite,
      rewriteFailures,
      rewriteAttempts,
      rewriteFailuresRecent,
      rewriteFailureRate,
      rewriteFailureRateAlertThreshold,
      rewriteConsecutiveFailuresAlertThreshold,
      rewriteMinSampleAlertThreshold,
    })
  ) {
    alerts.push("dream.health.rewrite_failing");
  }

  if (
    hasRewriteUnsearchableAlert({
      rewriteRejected,
      rewriteSearchabilityAttempts,
      rewriteRejectedRecent,
      rewriteUnsearchableRate,
      rewriteUnsearchableRateAlertThreshold,
      rewriteMinSampleAlertThreshold,
    })
  ) {
    alerts.push("dream.health.rewrite_unsearchable");
  }

  if (hasRewriteNoRecentSuccessAlert({ rewrite, now, healthRecencyWindowMs })) {
    alerts.push("dream.health.rewrite_no_recent_success");
  }

  if (hasPermanentFallbackAlert({ rewrite, now, permanentFallbackAfterMs })) {
    alerts.push("dream.health.rewrite_permanent_fallback");
  }

  alerts.push(...judgeAbstainingAlerts(db, opts, now, healthRecencyWindowMs));

  if (opts.requiredLlmRoleFloors) {
    const evaluation = evaluateLlmRoleFloors({
      agentchatConfig: opts.agentchatConfig,
      requiredRoles: opts.requiredLlmRoleFloors,
    });
    for (const violation of evaluation.violations) {
      alerts.push(roleFloorAlert(violation));
    }
  }

  return alerts;
}

export function logLlmRoleFloorViolations(input: {
  log: { error: (payload: Record<string, unknown>, msg: string) => void };
  evaluation: LlmRoleFloorEvaluation;
}): void {
  for (const violation of input.evaluation.violations) {
    input.log.error(
      {
        role: violation.role,
        consumer: violation.consumer,
        requiredHolders: violation.requiredHolders,
        actualHolders: violation.actualHolders,
        holderNames: violation.holderNames,
        reason: violation.reason,
      },
      "LLM role floor violation",
    );
  }
}
