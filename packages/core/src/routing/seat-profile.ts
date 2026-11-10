import { z } from "zod";

import { canonicalJson, sha256Hex } from "../evals/canonical.js";
import { wilson } from "../evals/stats.js";

/**
 * seat capability profiles — three encoding requirements:
 *
 * (i) engine_build must encode the engine build AND the serving config that
 *     changes outcomes: server context size (n_ctx), KV/cache flags and
 *     parallel slots.
 *
 * (ii) harness must encode harness name/version and the tool/permission set;
 *     the routing/effort policy lives in the routing_policy/effort_policy
 *     fingerprint fields, so that different recipes never share a key.
 *     A bench harness and an ACP harness are different strings.
 *
 * (iii) At the default minRootTasks of 5, the current coding-v2 corpus
 *       (3-4 tasks per tier) always yields sparse cells and an abstaining
 *       profile. This is intended conservative behaviour until the corpus
 *       grows or a caller lowers the threshold explicitly.
 */

export const SeatTierSchema = z.enum(["T1", "T2", "T3", "T4"]);
export type SeatTier = z.infer<typeof SeatTierSchema>;

export const SeatFingerprintSchema = z.strictObject({
  seat_id: z.string().min(1),
  model_sha: z.string().min(1).nullable(),
  engine_build: z.string().min(1).nullable(),
  template_hash: z.string().min(1).nullable(),
  sampling: z.string().min(1).nullable(),
  harness: z.string().min(1).nullable(),
  routing_policy: z.string().min(1).nullish(),
  effort_policy: z.string().min(1).nullish(),
});
export type SeatFingerprint = z.infer<typeof SeatFingerprintSchema>;

export function isSeatFingerprintComplete(fingerprint: SeatFingerprint): boolean {
  const routingPolicy = fingerprint.routing_policy ?? null;
  const effortPolicy = fingerprint.effort_policy ?? null;
  return (
    fingerprint.seat_id.length > 0 &&
    fingerprint.model_sha !== null &&
    fingerprint.model_sha.length > 0 &&
    fingerprint.engine_build !== null &&
    fingerprint.engine_build.length > 0 &&
    fingerprint.template_hash !== null &&
    fingerprint.template_hash.length > 0 &&
    fingerprint.sampling !== null &&
    fingerprint.sampling.length > 0 &&
    fingerprint.harness !== null &&
    fingerprint.harness.length > 0 &&
    (routingPolicy === null || routingPolicy.length > 0) &&
    (effortPolicy === null || effortPolicy.length > 0)
  );
}

export function seatFingerprintKey(fingerprint: SeatFingerprint): string {
  return sha256Hex(
    canonicalJson({
      seat_id: fingerprint.seat_id,
      model_sha: fingerprint.model_sha,
      engine_build: fingerprint.engine_build,
      template_hash: fingerprint.template_hash,
      sampling: fingerprint.sampling,
      harness: fingerprint.harness,
      routing_policy: fingerprint.routing_policy ?? null,
      effort_policy: fingerprint.effort_policy ?? null,
    }),
  );
}

export const SEAT_CONTEXT_BANDS = ["ctx_8k", "ctx_32k", "ctx_64k", "ctx_96k", "ctx_128k"] as const;
export type SeatContextBand = (typeof SEAT_CONTEXT_BANDS)[number];

export function contextBandFor(tokens: number): SeatContextBand | null {
  if (!Number.isFinite(tokens) || tokens < 0) return null;
  if (tokens <= 8192) return "ctx_8k";
  if (tokens <= 32768) return "ctx_32k";
  if (tokens <= 65536) return "ctx_64k";
  if (tokens <= 98304) return "ctx_96k";
  return "ctx_128k";
}

export const SeatEvidenceSchema = z.strictObject({
  evidence_id: z.string().min(1),
  fingerprint_key: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.enum(["bench", "dispatch"]),
  root_task_id: z.string().min(1),
  tier: SeatTierSchema,
  effort: z.string().min(1),
  budget: z.number().int().positive(),
  context_band: z.enum(SEAT_CONTEXT_BANDS),
  verdict: z.enum(["pass", "fail", "capacity"]),
  outcome: z.string().min(1),
  wall_seconds: z.number().nonnegative().nullable(),
  recorded_at: z.iso.datetime({ offset: true }),
});
export type SeatEvidence = z.infer<typeof SeatEvidenceSchema>;

export type SeatCellStatus = "qualified" | "sparse" | "stale";
export type SeatProfileStatus = "qualified" | "abstain";
export type SeatProfileAbstainReason =
  | "incomplete_fingerprint"
  | "no_matching_evidence"
  | "no_qualified_cells";

export interface SeatProfileCell {
  tier: SeatTier;
  effort: string;
  budget: number;
  context_band: SeatContextBand;
  root_tasks: number;
  capacity_root_tasks: number;
  attempts: number;
  pass_rate: number | null;
  interval: { lo: number; hi: number } | null;
  wall_seconds_p50: number | null;
  capacity_count: number;
  status: SeatCellStatus;
}

export interface SeatProfile {
  fingerprint_key: string;
  fingerprint: SeatFingerprint;
  status: SeatProfileStatus;
  abstain_reason?: SeatProfileAbstainReason;
  cells: SeatProfileCell[];
}

export interface SeatProfileBuildOptions {
  now: Date;
  minRootTasks?: number;
  maxAgeDays?: number;
}

interface SeatCellGroup {
  tier: SeatTier;
  effort: string;
  budget: number;
  context_band: SeatContextBand;
  evidence: SeatEvidence[];
}

const SEAT_TIER_ORDER: Record<SeatTier, number> = { T1: 0, T2: 1, T3: 2, T4: 3 };
const DAY_MS = 24 * 60 * 60 * 1000;

function abstainProfile(
  fingerprint: SeatFingerprint,
  fingerprintKey: string,
  reason: SeatProfileAbstainReason,
): SeatProfile {
  return {
    fingerprint_key: fingerprintKey,
    fingerprint,
    status: "abstain",
    abstain_reason: reason,
    cells: [],
  };
}

function groupEvidenceByCell(matching: SeatEvidence[]): Map<string, SeatCellGroup> {
  const groups = new Map<string, SeatCellGroup>();
  for (const ev of matching) {
    const cellKey = `${ev.tier}|${ev.effort}|${String(ev.budget)}|${ev.context_band}`;
    let group = groups.get(cellKey);
    if (group === undefined) {
      group = {
        tier: ev.tier,
        effort: ev.effort,
        budget: ev.budget,
        context_band: ev.context_band,
        evidence: [],
      };
      groups.set(cellKey, group);
    }
    group.evidence.push(ev);
  }
  return groups;
}

function splitFreshStale(
  cellEvidence: SeatEvidence[],
  cutoffMs: number,
): { fresh: SeatEvidence[]; staleCount: number } {
  const fresh: SeatEvidence[] = [];
  let staleCount = 0;
  for (const ev of cellEvidence) {
    if (Date.parse(ev.recorded_at) >= cutoffMs) {
      fresh.push(ev);
    } else {
      staleCount += 1;
    }
  }
  return { fresh, staleCount };
}

function cellPassStats(fresh: SeatEvidence[]): {
  rootTasks: number;
  capacityRootTasks: number;
  passRate: number | null;
  interval: { lo: number; hi: number } | null;
  capacityCount: number;
} {
  const taskGroups = new Map<string, SeatEvidence[]>();
  for (const ev of fresh) {
    const group = taskGroups.get(ev.root_task_id);
    if (group === undefined) {
      taskGroups.set(ev.root_task_id, [ev]);
    } else {
      group.push(ev);
    }
  }

  const fractions: number[] = [];
  let capacityCount = 0;
  let capacityRootTasks = 0;
  for (const taskEvidence of taskGroups.values()) {
    capacityCount += taskEvidence.filter((e) => e.verdict === "capacity").length;
    const nonCapacity = taskEvidence.filter((e) => e.verdict !== "capacity");
    if (nonCapacity.length === 0) {
      capacityRootTasks += 1;
      continue;
    }
    const passes = nonCapacity.filter((e) => e.verdict === "pass").length;
    fractions.push(passes / nonCapacity.length);
  }

  const rootTasks = fractions.length;
  if (rootTasks === 0) {
    return { rootTasks, capacityRootTasks, passRate: null, interval: null, capacityCount };
  }
  const successSum = fractions.reduce((sum, fraction) => sum + fraction, 0);
  const passRate = successSum / rootTasks;
  // Wilson over per-root-task fractions: each scored root task is one trial and
  // the summed fractions stand in for successes — an approximation because
  // per-task rates are not integer counts.
  const interval = wilson(successSum, rootTasks);
  return { rootTasks, capacityRootTasks, passRate, interval, capacityCount };
}

function wallSecondsP50(fresh: SeatEvidence[]): number | null {
  const values = fresh
    .map((e) => e.wall_seconds)
    .filter((ws): ws is number => ws !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  return values[Math.floor((values.length - 1) / 2)] ?? null;
}

function buildCell(group: SeatCellGroup, cutoffMs: number, minRootTasks: number): SeatProfileCell {
  const { fresh, staleCount } = splitFreshStale(group.evidence, cutoffMs);

  if (fresh.length === 0) {
    return {
      tier: group.tier,
      effort: group.effort,
      budget: group.budget,
      context_band: group.context_band,
      root_tasks: 0,
      capacity_root_tasks: 0,
      attempts: staleCount,
      pass_rate: null,
      interval: null,
      wall_seconds_p50: null,
      capacity_count: 0,
      status: "stale",
    };
  }

  const stats = cellPassStats(fresh);
  const sparse = stats.rootTasks < minRootTasks;
  return {
    tier: group.tier,
    effort: group.effort,
    budget: group.budget,
    context_band: group.context_band,
    root_tasks: stats.rootTasks,
    capacity_root_tasks: stats.capacityRootTasks,
    attempts: fresh.length,
    pass_rate: sparse ? null : stats.passRate,
    interval: stats.interval,
    wall_seconds_p50: wallSecondsP50(fresh),
    capacity_count: stats.capacityCount,
    status: sparse ? "sparse" : "qualified",
  };
}

function compareSeatCells(a: SeatProfileCell, b: SeatProfileCell): number {
  const tierDiff = SEAT_TIER_ORDER[a.tier] - SEAT_TIER_ORDER[b.tier];
  if (tierDiff !== 0) return tierDiff;
  const effortCmp = a.effort.localeCompare(b.effort);
  if (effortCmp !== 0) return effortCmp;
  if (a.budget !== b.budget) return a.budget - b.budget;
  return SEAT_CONTEXT_BANDS.indexOf(a.context_band) - SEAT_CONTEXT_BANDS.indexOf(b.context_band);
}

export function buildSeatProfile(
  evidence: SeatEvidence[],
  fingerprint: SeatFingerprint,
  opts: SeatProfileBuildOptions,
): SeatProfile {
  const fingerprintKey = seatFingerprintKey(fingerprint);
  if (!isSeatFingerprintComplete(fingerprint)) {
    return abstainProfile(fingerprint, fingerprintKey, "incomplete_fingerprint");
  }

  const matching = evidence.filter((e) => e.fingerprint_key === fingerprintKey);
  if (matching.length === 0) {
    return abstainProfile(fingerprint, fingerprintKey, "no_matching_evidence");
  }

  const cutoffMs = opts.now.getTime() - (opts.maxAgeDays ?? 30) * DAY_MS;
  const minRootTasks = opts.minRootTasks ?? 5;
  const cells = [...groupEvidenceByCell(matching).values()].map((group) =>
    buildCell(group, cutoffMs, minRootTasks),
  );
  cells.sort(compareSeatCells);

  if (cells.some((cell) => cell.status === "qualified")) {
    return { fingerprint_key: fingerprintKey, fingerprint, status: "qualified", cells };
  }
  return {
    fingerprint_key: fingerprintKey,
    fingerprint,
    status: "abstain",
    abstain_reason: "no_qualified_cells",
    cells,
  };
}
