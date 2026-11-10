import { z } from "zod";

import { firstAttemptEligibility } from "./attempts.js";
import {
  type Episode,
  type EpisodeBody,
  ModelFailureReasonSchema,
  type ReceiptClaimBody,
} from "./manifest.js";
import { clusterBootstrap, type Interval, manskiBounds, wilson } from "./stats.js";

const DEFAULT_BOOTSTRAP_REPLICATES = 2000;

const GROUP_BY_KEYS = ["recipe_id", "failure_type", "split"] as const;

type GroupByKey = (typeof GROUP_BY_KEYS)[number];

type ReceiptClaim = ReceiptClaimBody;

type ModelFailureReason = z.infer<typeof ModelFailureReasonSchema>;

type Failures = Record<ModelFailureReason, number>;

type VerifyResult =
  | {
      status: "verified";
      verdict: "pass" | "fail";
      fail_reason: ModelFailureReason | null;
      sha: string;
      control_verdict: "pass";
    }
  | { status: "rejected"; reason: string };

type VerifiedResult = Extract<VerifyResult, { status: "verified" }>;

interface ReceiptVerifier {
  verify(claim: ReceiptClaim, episode: Episode): Promise<VerifyResult>;
}

type VerifierFn = (episode: Episode, claim: ReceiptClaim) => VerifyResult | Promise<VerifyResult>;

type Verifier = ReceiptVerifier | VerifierFn;

type FixtureResolver = (ref: EpisodeBody["fixture_ref"]) => unknown;

type ClassifiedEpisode =
  | { kind: "solve" }
  | { kind: "model_failure"; reason: ModelFailureReason }
  | { kind: "excluded"; why: "environment" | "blocked_correct" }
  | { kind: "unknown" };

type Metric = {
  s: number;
  n: number;
  n_unknown: number;
  n_families: number;
  underpowered: boolean;
  rate: number | null;
  wilson: Interval | null;
  manski: Interval | null;
  cluster_ci: Interval | null;
};

type TokenReport = {
  sum: number;
  n_missing: number;
  n_incomplete: number;
  complete: boolean;
};

type GroupReport = {
  key: string;
  n_episodes: number;
  n_families: number;
  underpowered: boolean;
  n_excluded: { environment: number; blocked_correct: number };
  failures: Failures;
  solved_verified: Metric;
  first_attempt: Metric;
  tokens: TokenReport;
};

type AggregateOptions = {
  verifier: Verifier;
  resolveFixture: FixtureResolver;
  groupBy: string;
  minFamilies: number;
  seed: number;
  B?: number;
};

async function runVerifier(
  verifier: Verifier,
  episode: Episode,
  claim: ReceiptClaim,
): Promise<VerifyResult> {
  try {
    return typeof verifier === "function"
      ? await verifier(episode, claim)
      : await verifier.verify(claim, episode);
  } catch {
    return { status: "rejected", reason: "verifier_threw" };
  }
}

async function collectVerified(ep: Episode, verifier: Verifier): Promise<VerifiedResult[]> {
  const finalSha = ep.final_sha;
  const verified: VerifiedResult[] = [];
  if (finalSha === null) {
    return verified;
  }
  for (const claim of ep.receipts) {
    if (claim.kind !== "hidden_assertion" || claim.sha !== finalSha) {
      continue;
    }
    const result = await runVerifier(verifier, ep, claim);
    if (result.status === "verified" && result.sha === finalSha) {
      verified.push(result);
    }
  }
  return verified;
}

function verdictFromVerified(verified: readonly VerifiedResult[]): ClassifiedEpisode | null {
  if (verified.length === 0) {
    return null;
  }
  const passCount = verified.filter((result) => result.verdict === "pass").length;
  if (passCount === verified.length) {
    return { kind: "solve" };
  }
  if (passCount > 0) {
    return { kind: "model_failure", reason: "nondeterministic" };
  }
  const firstFailing = verified.find((result) => result.verdict === "fail");
  return { kind: "model_failure", reason: firstFailing?.fail_reason ?? "hidden_failed" };
}

function fixtureExpectsBlock(fixture: unknown): boolean {
  return (
    typeof fixture === "object" &&
    fixture !== null &&
    (fixture as { expect_blocked?: unknown }).expect_blocked === true
  );
}

function classifyFromObserved(ep: Episode, resolveFixture: FixtureResolver): ClassifiedEpisode {
  const outcome = ep.observed_outcome;
  switch (outcome.class) {
    case "model_failure":
      return { kind: "model_failure", reason: outcome.reason };
    case "environment_failure":
      return { kind: "excluded", why: "environment" };
    case "blocked_correct":
      if (fixtureExpectsBlock(resolveFixture(ep.fixture_ref))) {
        return { kind: "excluded", why: "blocked_correct" };
      }
      return { kind: "model_failure", reason: "incorrect_blocked" };
    case "terminal_unverified":
    case "unknown":
      return { kind: "unknown" };
  }
}

async function classifyEpisode(
  ep: Episode,
  opts: { verifier: Verifier; resolveFixture: FixtureResolver },
): Promise<ClassifiedEpisode> {
  const byVerifier = verdictFromVerified(await collectVerified(ep, opts.verifier));
  if (byVerifier !== null) {
    return byVerifier;
  }
  return classifyFromObserved(ep, opts.resolveFixture);
}

type FamilyTally = { s: number; n: number };

type MetricAcc = {
  s: number;
  n: number;
  nUnknown: number;
  families: Map<string, FamilyTally>;
};

function newMetric(): MetricAcc {
  return { s: 0, n: 0, nUnknown: 0, families: new Map() };
}

function familyTally(families: Map<string, FamilyTally>, familyId: string): FamilyTally {
  const existing = families.get(familyId);
  if (existing !== undefined) {
    return existing;
  }
  const created: FamilyTally = { s: 0, n: 0 };
  families.set(familyId, created);
  return created;
}

function newFailures(): Failures {
  const failures = {} as Failures;
  for (const reason of ModelFailureReasonSchema.options) {
    failures[reason] = 0;
  }
  return failures;
}

type GroupAcc = {
  key: string;
  nEpisodes: number;
  solved: MetricAcc;
  firstAttempt: MetricAcc;
  nExcluded: { environment: number; blocked_correct: number };
  failures: Failures;
  tokens: { sum: number; nMissing: number; nIncomplete: number };
};

function newGroup(key: string): GroupAcc {
  return {
    key,
    nEpisodes: 0,
    solved: newMetric(),
    firstAttempt: newMetric(),
    nExcluded: { environment: 0, blocked_correct: 0 },
    failures: newFailures(),
    tokens: { sum: 0, nMissing: 0, nIncomplete: 0 },
  };
}

function groupTally(groups: Map<string, GroupAcc>, key: string): GroupAcc {
  const existing = groups.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = newGroup(key);
  groups.set(key, created);
  return created;
}

function accumulateSolved(group: GroupAcc, familyId: string, cls: ClassifiedEpisode): void {
  if (cls.kind === "excluded") {
    group.nExcluded[cls.why] += 1;
    return;
  }
  const acc = group.solved;
  if (cls.kind === "unknown") {
    acc.nUnknown += 1;
    return;
  }
  const family = familyTally(acc.families, familyId);
  if (cls.kind === "solve") {
    acc.s += 1;
    acc.n += 1;
    family.s += 1;
    family.n += 1;
    return;
  }
  acc.n += 1;
  family.n += 1;
  group.failures[cls.reason] += 1;
}

function accumulateFirstAttempt(
  acc: MetricAcc,
  ep: Episode,
  familyId: string,
  cls: ClassifiedEpisode,
): void {
  if (cls.kind === "excluded") {
    return;
  }
  if (cls.kind === "unknown") {
    acc.nUnknown += 1;
    return;
  }
  const eligibility = firstAttemptEligibility(ep);
  if (eligibility === "unknown") {
    acc.nUnknown += 1;
    return;
  }
  const family = familyTally(acc.families, familyId);
  if (eligibility === "eligible" && cls.kind === "solve") {
    acc.s += 1;
    acc.n += 1;
    family.s += 1;
    family.n += 1;
    return;
  }
  acc.n += 1;
  family.n += 1;
}

function accumulateTokens(acc: GroupAcc["tokens"], ep: Episode): void {
  const usage = ep.lineage_usage;
  if (usage === null) {
    acc.nMissing += 1;
    return;
  }
  if (usage.tokens === null) {
    acc.nMissing += 1;
    return;
  }
  acc.sum += usage.tokens;
  if (!usage.complete) {
    acc.nIncomplete += 1;
  }
}

function assertGroupBy(groupBy: string): GroupByKey {
  if ((GROUP_BY_KEYS as readonly string[]).includes(groupBy)) {
    return groupBy as GroupByKey;
  }
  throw new Error(`unsupported groupBy key: ${groupBy}`);
}

function groupKeyOf(ep: Episode, groupBy: GroupByKey): string {
  return ep[groupBy] ?? "none";
}

function finalizeMetric(
  acc: MetricAcc,
  opts: { minFamilies: number; seed: number; B: number },
): Metric {
  const nFamilies = acc.families.size;
  const underpowered = nFamilies < opts.minFamilies;
  const clusters = [...acc.families.values()].map((family) => ({ s: family.s, n: family.n }));
  const clusterCi = underpowered
    ? null
    : clusterBootstrap(clusters, { seed: opts.seed, B: opts.B });
  return {
    s: acc.s,
    n: acc.n,
    n_unknown: acc.nUnknown,
    n_families: nFamilies,
    underpowered,
    rate: acc.n === 0 ? null : acc.s / acc.n,
    wilson: wilson(acc.s, acc.n),
    manski: manskiBounds(acc.s, acc.n - acc.s, acc.nUnknown),
    cluster_ci: clusterCi,
  };
}

function buildGroup(
  acc: GroupAcc,
  opts: { minFamilies: number; seed: number; B: number },
): GroupReport {
  const solvedVerified = finalizeMetric(acc.solved, opts);
  const firstAttempt = finalizeMetric(acc.firstAttempt, opts);
  return {
    key: acc.key,
    n_episodes: acc.nEpisodes,
    n_families: solvedVerified.n_families,
    underpowered: solvedVerified.underpowered,
    n_excluded: { ...acc.nExcluded },
    failures: acc.failures,
    solved_verified: solvedVerified,
    first_attempt: firstAttempt,
    tokens: {
      sum: acc.tokens.sum,
      n_missing: acc.tokens.nMissing,
      n_incomplete: acc.tokens.nIncomplete,
      complete: acc.tokens.nMissing === 0 && acc.tokens.nIncomplete === 0,
    },
  };
}

async function aggregateEpisodes(
  episodes: readonly Episode[],
  opts: AggregateOptions,
): Promise<{ groups: GroupReport[] }> {
  const groupBy = assertGroupBy(opts.groupBy);
  const B = opts.B ?? DEFAULT_BOOTSTRAP_REPLICATES;
  const groups = new Map<string, GroupAcc>();
  for (const ep of episodes) {
    const group = groupTally(groups, groupKeyOf(ep, groupBy));
    group.nEpisodes += 1;
    const cls = await classifyEpisode(ep, {
      verifier: opts.verifier,
      resolveFixture: opts.resolveFixture,
    });
    accumulateSolved(group, ep.family_id, cls);
    accumulateFirstAttempt(group.firstAttempt, ep, ep.family_id, cls);
    accumulateTokens(group.tokens, ep);
  }
  const sorted = [...groups.values()].sort((lhs, rhs) => (lhs.key < rhs.key ? -1 : 1));
  return {
    groups: sorted.map((group) =>
      buildGroup(group, { minFamilies: opts.minFamilies, seed: opts.seed, B }),
    ),
  };
}

const aggregate = aggregateEpisodes;

export {
  aggregate,
  aggregateEpisodes,
  assertGroupBy,
  type ClassifiedEpisode,
  classifyEpisode,
  GROUP_BY_KEYS,
  type GroupByKey,
  groupKeyOf,
  type GroupReport,
  type Metric,
  type ModelFailureReason,
  type ReceiptClaim,
  type ReceiptVerifier,
  type Verifier,
  type VerifyResult,
};
