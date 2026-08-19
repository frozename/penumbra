import type { Database } from "bun:sqlite";

import { DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES } from "../dreaming/config.js";

const PRIMARY_TIER = "primary";
export const DREAM_QUERY_REWRITE_SUBSYSTEM = "dream.query_rewrite";
const PERMANENT_FALLBACK_AFTER_MS = 6 * 60 * 60_000;
const QUERY_REWRITE_FAILURE_RATE_ALERT_THRESHOLD = 0.9;
const QUERY_REWRITE_CONSECUTIVE_FAILURES_ALERT_THRESHOLD = 3;

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
  ok: boolean;
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
  updated_at: string;
}

export interface ComputeSubsystemAlertsOptions {
  now?: Date;
  permanentFallbackAfterMs?: number;
  queryRewriteFailed24h?: number;
  queryRewriteSuccess24h?: number;
  queryRewriteFailedRecent?: number;
  queryRewriteFailureRateAlertThreshold?: number;
  queryRewriteConsecutiveFailuresAlertThreshold?: number;
  requiredLlmRoleFloors?: LlmRoleFloorSpec[];
  agentchatConfig?: LlmRoleAgentchatConfig | null;
}

export interface BuildRequiredLlmRoleFloorsOptions {
  env?: Record<string, string | undefined>;
  dreamingAutoPromoteMinJudges?: number;
}

function envRole(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
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

function roleFloorAlert(violation: LlmRoleFloorViolation): string {
  return `llm.role_floor.${violation.role}.required_${String(
    violation.requiredHolders,
  )}.actual_${String(violation.actualHolders)}`;
}

function normalizeTs(ts: Date | string | undefined): string {
  if (ts === undefined) return new Date().toISOString();
  return typeof ts === "string" ? ts : ts.toISOString();
}

export function recordSubsystemOutcome(db: Database, input: RecordSubsystemOutcomeInput): void {
  const ts = normalizeTs(input.ts);
  const existing = readSubsystemHealth(db, input.subsystem);
  const isPrimary = input.tier === PRIMARY_TIER;
  const consecutiveFailures = input.ok
    ? isPrimary
      ? 0
      : (existing?.consecutive_failures ?? 0)
    : (existing?.consecutive_failures ?? 0) + 1;
  const lastSuccessTs = input.ok ? ts : (existing?.last_success_ts ?? null);
  const lastFailureTs = input.ok ? (existing?.last_failure_ts ?? null) : ts;
  const lastFailureReason = input.ok
    ? (existing?.last_failure_reason ?? null)
    : (input.reason ?? null);
  const lastFailureStatus = input.ok
    ? (existing?.last_failure_status ?? null)
    : (input.status ?? null);
  const firstNonPrimaryTs = isPrimary ? null : (existing?.first_non_primary_ts ?? ts);

  db.run(
    `INSERT INTO subsystem_health (
       subsystem, tier, seat, model, host, consecutive_failures, last_success_ts,
       last_failure_ts, last_failure_reason, last_failure_status,
       first_non_primary_ts, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                last_failure_status, first_non_primary_ts, updated_at
         FROM subsystem_health
         WHERE subsystem = ?`,
      )
      .get(subsystem) ?? null
  );
}

export function computeSubsystemAlerts(
  db: Database,
  opts: ComputeSubsystemAlertsOptions = {},
): string[] {
  const alerts: string[] = [];
  const now = opts.now ?? new Date();
  const permanentFallbackAfterMs = opts.permanentFallbackAfterMs ?? PERMANENT_FALLBACK_AFTER_MS;
  const rewriteFailures = opts.queryRewriteFailed24h ?? 0;
  const rewriteSuccesses = opts.queryRewriteSuccess24h ?? 0;
  const rewriteFailuresRecent = opts.queryRewriteFailedRecent;
  const rewriteAttempts = rewriteFailures + rewriteSuccesses;
  const rewriteFailureRate = rewriteAttempts > 0 ? rewriteFailures / rewriteAttempts : 0;
  const rewriteFailureRateAlertThreshold =
    opts.queryRewriteFailureRateAlertThreshold ?? QUERY_REWRITE_FAILURE_RATE_ALERT_THRESHOLD;
  const rewriteConsecutiveFailuresAlertThreshold =
    opts.queryRewriteConsecutiveFailuresAlertThreshold ??
    QUERY_REWRITE_CONSECUTIVE_FAILURES_ALERT_THRESHOLD;
  const rewrite = readSubsystemHealth(db, DREAM_QUERY_REWRITE_SUBSYSTEM);

  const rewriteVolumeFailure =
    rewriteFailures > 0 &&
    rewriteFailureRate >= rewriteFailureRateAlertThreshold &&
    (rewriteFailuresRecent === undefined || rewriteFailuresRecent > 0);
  const rewriteConsecutiveFailure =
    (rewrite?.consecutive_failures ?? 0) >= rewriteConsecutiveFailuresAlertThreshold;

  if (rewriteVolumeFailure || rewriteConsecutiveFailure) {
    alerts.push("dream.health.rewrite_failing");
  }

  if (
    rewrite?.tier !== undefined &&
    rewrite.tier !== PRIMARY_TIER &&
    rewrite.first_non_primary_ts !== null
  ) {
    const firstNonPrimaryMs = Date.parse(rewrite.first_non_primary_ts);
    if (
      Number.isFinite(firstNonPrimaryMs) &&
      now.getTime() - firstNonPrimaryMs >= permanentFallbackAfterMs
    ) {
      alerts.push("dream.health.rewrite_permanent_fallback");
    }
  }

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
