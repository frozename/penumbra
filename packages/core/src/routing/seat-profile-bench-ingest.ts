import { z } from "zod";

import type { SeatContextBand, SeatEvidence, SeatFingerprint } from "./seat-profile.js";

import { canonicalJson, sha256Hex } from "../evals/canonical.js";
import { contextBandFor, SeatEvidenceSchema, seatFingerprintKey } from "./seat-profile.js";

const SEAT_TIER_SCHEMA = z.enum(["T1", "T2", "T3", "T4"]);

const benchRowSchema = z.looseObject({
  pass: z.boolean(),
  outcome: z.string(),
  task: z.string().min(1),
  tier: SEAT_TIER_SCHEMA,
  effort: z.string().min(1),
  budget: z.number().int().positive(),
  fixture_sha: z.string().min(1),
  rep: z.number().int().nonnegative(),
  label: z.string(),
  ended_epoch: z.number().int().positive(),
  wall_seconds: z.number().nullable().optional(),
  prior_context_tokens: z.number().optional(),
  sampling: z.string().nullable().optional(),
  routing_policy: z.string().nullable().optional(),
  effort_policy: z.string().nullable().optional(),
  turns: z.array(z.looseObject({ prompt_tokens: z.number().nullable().optional() })),
});

type BenchRow = z.infer<typeof benchRowSchema>;

const VERDICT_MAP: Record<string, "pass" | "fail" | "capacity"> = {
  pass: "pass",
  "wall-cap": "capacity",
  "context-overflow": "capacity",
  "request-timeout": "capacity",
  truncated: "capacity",
  "turn-cap": "fail",
  "model-fail": "fail",
  "gave-up": "fail",
};

export interface CodingV2BenchIngestOptions {
  fingerprint: SeatFingerprint;
  routingPolicy?: string | null;
  effortPolicy?: string | null;
}

export interface CodingV2BenchRejection {
  line: number;
  reason: string;
}

export interface CodingV2BenchExclusion {
  line: number;
  outcome: string;
}

export interface CodingV2BenchIngestResult {
  evidence: SeatEvidence[];
  rejected: CodingV2BenchRejection[];
  excluded: CodingV2BenchExclusion[];
}

type StepResult<T> = { ok: true; value: T } | { ok: false; reason: string };
type GuardResult = { ok: true } | { ok: false; reason: string };

type BenchLineResult =
  | { kind: "evidence"; record: SeatEvidence }
  | { kind: "rejected"; reason: string }
  | { kind: "excluded"; outcome: string };

interface IngestContext {
  fingerprint: SeatFingerprint;
  fingerprintKey: string;
  routingPolicy: string | null;
  effortPolicy: string | null;
}

function parseBenchJson(line: string): StepResult<unknown> {
  try {
    const value: unknown = JSON.parse(line);
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function harnessErrorOutcome(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("outcome" in value)) {
    return null;
  }
  const outcome = value.outcome;
  if (outcome === "harness-error" || outcome === "harness-unparsed") {
    return outcome;
  }
  return null;
}

function benchRowFromValue(value: unknown): StepResult<BenchRow> {
  const result = benchRowSchema.safeParse(value);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.map((p) => String(p)).join(".") ?? "";
    return { ok: false, reason: `schema:${path}` };
  }
  return { ok: true, value: result.data };
}

function samplingMatches(rowSampling: string, fpSampling: string | null): boolean {
  return (
    fpSampling !== null && (fpSampling === rowSampling || fpSampling.startsWith(`${rowSampling}:`))
  );
}

function fingerprintGuard(row: BenchRow, ctx: IngestContext): GuardResult {
  if (
    typeof row.sampling === "string" &&
    !samplingMatches(row.sampling, ctx.fingerprint.sampling)
  ) {
    return { ok: false, reason: "fingerprint_mismatch:sampling" };
  }
  const rowRoutingPolicy = row.routing_policy === undefined ? null : row.routing_policy;
  const rowEffortPolicy = row.effort_policy === undefined ? null : row.effort_policy;
  if (rowRoutingPolicy !== ctx.routingPolicy) {
    return { ok: false, reason: "fingerprint_mismatch:routing_policy" };
  }
  if (rowEffortPolicy !== ctx.effortPolicy) {
    return { ok: false, reason: "fingerprint_mismatch:effort_policy" };
  }
  return { ok: true };
}

function benchVerdict(row: BenchRow): StepResult<"pass" | "fail" | "capacity"> {
  const verdict = VERDICT_MAP[row.outcome];
  if (verdict === undefined) {
    return { ok: false, reason: "unknown_outcome" };
  }
  const agrees = verdict === "pass" ? row.pass : !row.pass;
  if (!agrees) {
    return { ok: false, reason: "pass_outcome_mismatch" };
  }
  return { ok: true, value: verdict };
}

function startingContextTokens(row: BenchRow): number | undefined {
  if (typeof row.prior_context_tokens === "number" && Number.isFinite(row.prior_context_tokens)) {
    return row.prior_context_tokens;
  }
  const firstPromptTokens = row.turns[0]?.prompt_tokens;
  return typeof firstPromptTokens === "number" ? firstPromptTokens : undefined;
}

function benchContextBand(row: BenchRow): StepResult<SeatContextBand> {
  const startingContext = startingContextTokens(row);
  const band = startingContext === undefined ? null : contextBandFor(startingContext);
  if (band === null) {
    return { ok: false, reason: "no_context_measurement" };
  }
  return { ok: true, value: band };
}

function buildBenchEvidence(
  row: BenchRow,
  verdict: "pass" | "fail" | "capacity",
  contextBand: SeatContextBand,
  ctx: IngestContext,
): SeatEvidence {
  const record: SeatEvidence = {
    evidence_id: sha256Hex(
      canonicalJson({
        fingerprint_key: ctx.fingerprintKey,
        label: row.label,
        task: row.task,
        rep: row.rep,
        ended_epoch: row.ended_epoch,
      }),
    ),
    fingerprint_key: ctx.fingerprintKey,
    source: "bench",
    root_task_id: `coding-v2:${row.task}:${row.fixture_sha}`,
    tier: row.tier,
    effort: row.effort,
    budget: row.budget,
    context_band: contextBand,
    verdict,
    outcome: row.outcome,
    wall_seconds: row.wall_seconds ?? null,
    recorded_at: new Date(row.ended_epoch * 1000).toISOString(),
  };
  return SeatEvidenceSchema.parse(record);
}

function ingestBenchLine(line: string, ctx: IngestContext): BenchLineResult {
  const parsed = parseBenchJson(line);
  if (!parsed.ok) return { kind: "rejected", reason: parsed.reason };

  const excludedOutcome = harnessErrorOutcome(parsed.value);
  if (excludedOutcome !== null) return { kind: "excluded", outcome: excludedOutcome };

  const rowResult = benchRowFromValue(parsed.value);
  if (!rowResult.ok) return { kind: "rejected", reason: rowResult.reason };
  const row = rowResult.value;

  const guard = fingerprintGuard(row, ctx);
  if (!guard.ok) return { kind: "rejected", reason: guard.reason };

  const verdictResult = benchVerdict(row);
  if (!verdictResult.ok) return { kind: "rejected", reason: verdictResult.reason };

  const bandResult = benchContextBand(row);
  if (!bandResult.ok) return { kind: "rejected", reason: bandResult.reason };

  return {
    kind: "evidence",
    record: buildBenchEvidence(row, verdictResult.value, bandResult.value, ctx),
  };
}

export function ingestCodingV2BenchRows(
  text: string,
  opts: CodingV2BenchIngestOptions,
): CodingV2BenchIngestResult {
  const ctx: IngestContext = {
    fingerprint: opts.fingerprint,
    fingerprintKey: seatFingerprintKey(opts.fingerprint),
    routingPolicy: opts.routingPolicy ?? opts.fingerprint.routing_policy ?? null,
    effortPolicy: opts.effortPolicy ?? opts.fingerprint.effort_policy ?? null,
  };
  const evidence: SeatEvidence[] = [];
  const rejected: CodingV2BenchRejection[] = [];
  const excluded: CodingV2BenchExclusion[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const result = ingestBenchLine(line, ctx);
    if (result.kind === "evidence") {
      evidence.push(result.record);
    } else if (result.kind === "rejected") {
      rejected.push({ line: index + 1, reason: result.reason });
    } else {
      excluded.push({ line: index + 1, outcome: result.outcome });
    }
  }

  return { evidence, rejected, excluded };
}
