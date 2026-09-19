import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  TypesafeClient,
  TypesafeEnvInput,
  TypesafeFetch,
  TypesafeSettings,
} from "../packages/integrations/typesafe/src/index.js";
import type { PromotionAnswers } from "../packages/integrations/typesafe/src/questions/promotion.js";

import { getConfig } from "../packages/config/src/index.js";
import { Branding, resolveStorageDbPath } from "../packages/core/src/index.js";
import { likeToRegex } from "../packages/daemon/src/dreaming/curator/t2-ephemera-detector.js";
import {
  EPHEMERA_PROMPT_LIKE_PATTERNS,
  KNOWN_LONG_LIVED_DISPATCHER_USER_IDS,
} from "../packages/daemon/src/dreaming/cycle.js";
import {
  createTypesafeClient,
  resolveTypesafeSettings,
} from "../packages/integrations/typesafe/src/index.js";
import {
  judgePromotion,
  PROMOTION_PINNED_MODEL_ID,
  PROMOTION_QUESTIONS,
  promotionUsdForInputTokens,
} from "../packages/integrations/typesafe/src/questions/promotion.js";

export interface DegradedWindow {
  from: string;
  to: string;
}

export const DEFAULT_DEGRADED_WINDOW: DegradedWindow = {
  from: "2026-09-11T22:29:42Z",
  to: "2026-09-18T20:00:00Z",
};

export const DEFAULT_LIVE_MAX_USD = 0.05;
export const MAX_LIVE_BODY_CHARS = 16_000;

const LIVE_ESTIMATE_CHARS_PER_TOKEN = 3;
// Everything on the wire except the rollup excerpt: the four promotion
// questions, the pinned model id and the JSON envelope.
const LIVE_REQUEST_OVERHEAD_CHARS = JSON.stringify({
  state: { kind: "promote_t1", body: "" },
  model: PROMOTION_PINNED_MODEL_ID,
  questions: PROMOTION_QUESTIONS,
}).length;

function estimateLiveRequestUsd(sendBody: string): number {
  const estimatedTokens = Math.ceil(
    (sendBody.length + LIVE_REQUEST_OVERHEAD_CHARS) / LIVE_ESTIMATE_CHARS_PER_TOKEN,
  );
  return promotionUsdForInputTokens(estimatedTokens);
}

export interface ShadowEvalArgs {
  dbPath: string;
  outPath: string;
  limit: number;
  since: string | null;
  degradedWindow: DegradedWindow;
  live: boolean;
  maxRollups: number | null;
  maxUsd: number;
}

interface ArgsDraft {
  dbArg: string | null;
  outArg: string | null;
  limit: number;
  since: string | null;
  degradedFrom: string;
  degradedTo: string;
  live: boolean;
  maxRollups: number | null;
  maxUsd: number;
}

function parseIsoFlag(flag: string, value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`invalid ${flag}: ${value}`);
  return value;
}

function applyFlag(draft: ArgsDraft, flag: string, value: string): void {
  switch (flag) {
    case "--db":
      draft.dbArg = value;
      return;
    case "--out":
      draft.outArg = value;
      return;
    case "--limit":
    case "--max-rollups": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`invalid ${flag}: ${value}`);
      }
      draft[flag === "--limit" ? "limit" : "maxRollups"] = parsed;
      return;
    }
    case "--since":
      draft.since = parseIsoFlag("--since", value);
      return;
    case "--degraded-from":
      draft.degradedFrom = parseIsoFlag("--degraded-from", value);
      return;
    case "--degraded-to":
      draft.degradedTo = parseIsoFlag("--degraded-to", value);
      return;
    case "--max-usd": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid --max-usd: ${value}`);
      }
      draft.maxUsd = parsed;
      return;
    }
    default:
      throw new Error(`unknown flag: ${flag}`);
  }
}

export function parseShadowEvalArgs(argv: string[]): ShadowEvalArgs {
  const draft: ArgsDraft = {
    dbArg: null,
    outArg: null,
    limit: 50,
    since: null,
    degradedFrom: DEFAULT_DEGRADED_WINDOW.from,
    degradedTo: DEFAULT_DEGRADED_WINDOW.to,
    live: false,
    maxRollups: null,
    maxUsd: DEFAULT_LIVE_MAX_USD,
  };

  const rest = [...argv];
  for (;;) {
    const arg = rest.shift();
    if (arg === undefined) break;
    if (arg === "--live") {
      draft.live = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined) {
      throw new Error(`flag requires a value: ${arg}`);
    }
    applyFlag(draft, arg, value);
  }

  if (draft.outArg === null) {
    throw new Error("--out is required");
  }
  if (draft.live && draft.maxRollups === null) {
    throw new Error("--live requires --max-rollups N");
  }
  const storageRoot = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;
  const dbPath = draft.dbArg !== null ? resolve(draft.dbArg) : resolveStorageDbPath(storageRoot);
  return {
    dbPath,
    outPath: resolve(draft.outArg),
    limit: draft.limit,
    since: draft.since,
    degradedWindow: { from: draft.degradedFrom, to: draft.degradedTo },
    live: draft.live,
    maxRollups: draft.maxRollups,
    maxUsd: draft.maxUsd,
  };
}

export function openReplayDb(path: string): Database {
  return new Database(path, { readonly: true });
}

export interface LoadedJudgement {
  rollupId: string;
  body: string;
  userId: string | null;
  ballots: unknown;
  storedConfidence: number | null;
  judgedAtMs: number | null;
}

export interface LoadedReplay {
  totalEligible: number;
  unlabelled: number;
  excludedDegraded: number;
  excludedNoTimestamp: number;
  rows: LoadedJudgement[];
}

interface ReplayRawRow {
  rollup_id: string;
  body: string;
  user_id: string | null;
  payload_json: string | null;
  stored_confidence: number | null;
  judged_at_ms: number | null;
}

// LEFT JOIN mirrors cycle.ts: insufficient-vote rollups write no
// dream_actions row at all, and json_array(target) is how P1 stores the
// single-rollup target list.
const REPLAY_QUERY = `
  SELECT r.rollup_id            AS rollup_id,
         r.first_prompt_excerpt AS body,
         r.user_id              AS user_id,
         da.payload_json        AS payload_json,
         da.confidence          AS stored_confidence,
         dc.started_at          AS judged_at_ms
    FROM t1_rollups r
    LEFT JOIN dream_actions da
      ON da.phase = 'P1'
     AND da.action_type = 'promote_t1'
     AND da.target_ids = json_array(r.rollup_id)
    LEFT JOIN dream_cycles dc
      ON dc.cycle_id = da.cycle_id
   WHERE r.first_prompt_excerpt IS NOT NULL
     AND length(trim(r.first_prompt_excerpt)) >= 40`;

function extractBallots(payloadJson: string): unknown {
  const parsed: unknown = JSON.parse(payloadJson);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)["votes"]
    : null;
}

function isLabelled(row: ReplayRawRow): row is ReplayRawRow & { payload_json: string } {
  return row.payload_json !== null;
}

interface ReplayWindowOpts {
  sinceMs: number | null;
  degradedFromMs: number;
  degradedToMs: number;
}

function judgementSurvives(
  row: ReplayRawRow & { payload_json: string },
  opts: ReplayWindowOpts,
): boolean {
  const ms = row.judged_at_ms;
  const inDegraded = ms !== null && ms >= opts.degradedFromMs && ms < opts.degradedToMs;
  return !inDegraded && (opts.sinceMs === null || (ms !== null && ms >= opts.sinceMs));
}

type ReplayPick =
  | { kind: "unlabelled" }
  | { kind: "excluded" }
  | { kind: "no_timestamp" }
  | { kind: "kept"; latest: ReplayRawRow & { payload_json: string } };

function pickReplayJudgement(rows: readonly ReplayRawRow[], opts: ReplayWindowOpts): ReplayPick {
  const labelled = rows.filter(isLabelled);
  if (labelled.length === 0) {
    return { kind: "unlabelled" };
  }
  const surviving = labelled.filter((row) => judgementSurvives(row, opts));
  if (surviving.length === 0) {
    // A labelled judgement whose joined dream-cycle started_at is NULL cannot be
    // evaluated against --since; counting it as degraded would be a silent drop.
    // One NULL row poisons the group even when siblings carry timestamps.
    if (opts.sinceMs !== null && labelled.some((row) => row.judged_at_ms === null)) {
      return { kind: "no_timestamp" };
    }
    return { kind: "excluded" };
  }
  const latest = surviving.sort((a, b) => (b.judged_at_ms ?? 0) - (a.judged_at_ms ?? 0))[0];
  return latest === undefined ? { kind: "excluded" } : { kind: "kept", latest };
}

export function loadReplayRollups(
  db: Database,
  opts: {
    sinceMs: number | null;
    degradedFromMs: number;
    degradedToMs: number;
    limit: number;
  },
): LoadedReplay {
  const rawRows = db.query<ReplayRawRow, []>(REPLAY_QUERY).all();
  const groups = new Map<string, ReplayRawRow[]>();
  for (const row of rawRows) {
    const group = groups.get(row.rollup_id);
    if (group === undefined) {
      groups.set(row.rollup_id, [row]);
    } else {
      group.push(row);
    }
  }

  let unlabelled = 0;
  let excludedDegraded = 0;
  let excludedNoTimestamp = 0;
  const kept: LoadedJudgement[] = [];
  for (const [rollupId, rows] of groups) {
    const pick = pickReplayJudgement(rows, opts);
    if (pick.kind === "unlabelled") unlabelled += 1;
    else if (pick.kind === "no_timestamp") excludedNoTimestamp += 1;
    else if (pick.kind === "excluded") excludedDegraded += 1;
    else
      kept.push({
        rollupId,
        body: pick.latest.body,
        userId: pick.latest.user_id,
        ballots: extractBallots(pick.latest.payload_json),
        storedConfidence: pick.latest.stored_confidence,
        judgedAtMs: pick.latest.judged_at_ms,
      });
  }
  kept.sort((a, b) => (b.judgedAtMs ?? 0) - (a.judgedAtMs ?? 0));

  return {
    totalEligible: groups.size,
    unlabelled,
    excludedDegraded,
    excludedNoTimestamp,
    rows: kept.slice(0, opts.limit),
  };
}

// JS mirror of the two claim-side filters in cycle.ts's claimT1Rollups, using
// the same likeToRegex the curator ephemera detector applies to the patterns.
const EPHEMERA_PROMPT_REGEXES = EPHEMERA_PROMPT_LIKE_PATTERNS.map(likeToRegex);

export function isClaimEligibleRollup(body: string | null, userId: string | null): boolean {
  const ephemeraHit = body !== null && EPHEMERA_PROMPT_REGEXES.some((re) => re.test(body));
  return (
    !ephemeraHit && (userId === null || !KNOWN_LONG_LIVED_DISPATCHER_USER_IDS.includes(userId))
  );
}

export type IncumbentDecision = "promote" | "no_promote" | "insufficient";

export interface IncumbentInput {
  ballots: unknown;
  // dream_actions.confidence — the stored YES/NO confidence average, not a
  // promote probability. In scope so the ballot-only computation is auditable
  // against it; deliberately never consulted for pYes.
  storedConfidence: number | null;
}

export interface IncumbentVerdict {
  ballots: unknown;
  counted: number;
  unparseable: number;
  pYes: number | null;
  decision: IncumbentDecision;
}

// Mirrors the P1 quorum floor in cycle.ts (autoPromoteMinJudges default
// DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES = 2, daemon config.ts:3).
const INCUMBENT_MIN_COUNTED_BALLOTS = 2;

type BallotClass = "yes" | "no" | "abstained" | "unparseable";

function classifyBallot(vote: unknown): BallotClass {
  if (typeof vote !== "object" || vote === null) return "unparseable";
  const record = vote as Record<string, unknown>;
  if (record["abstained"] === true) return "abstained";
  return typeof record["promote"] === "boolean"
    ? record["promote"]
      ? "yes"
      : "no"
    : "unparseable";
}

export function incumbentFromBallots(input: IncumbentInput): IncumbentVerdict {
  const list = Array.isArray(input.ballots) ? input.ballots : [];
  let counted = 0;
  let unparseable = 0;
  let yes = 0;
  for (const vote of list) {
    const cls = classifyBallot(vote);
    if (cls === "abstained") continue;
    if (cls === "unparseable") {
      unparseable += 1;
      continue;
    }
    counted += 1;
    if (cls === "yes") yes += 1;
  }
  const pYes = counted === 0 ? null : yes / counted;
  const decision: IncumbentDecision =
    counted < INCUMBENT_MIN_COUNTED_BALLOTS
      ? "insufficient"
      : yes >= Math.ceil((counted * 2) / 3)
        ? "promote"
        : "no_promote";
  return { ballots: input.ballots, counted, unparseable, pYes, decision };
}

export interface ShadowEvalRowResult {
  incumbentDecision: IncumbentDecision;
  incumbentPYes: number | null;
  incumbentUnparseable: number;
  bodyTruncated: boolean;
  claimEligible: boolean;
  jev:
    | { status: "skipped" }
    | {
        status: "answered";
        pPromote: number;
        shadowPromote: boolean;
        inputTokens: number;
        usd: number;
      }
    | { status: "failed" };
}

export interface ShadowReplayMeta {
  dbPath: string;
  degradedWindow: DegradedWindow;
  since: string | null;
  totalEligible: number;
  unlabelled: number;
  excludedDegraded: number;
  excludedNoTimestamp: number;
  maxRollups: number | null;
  maxUsd: number;
  projectedStop: boolean;
}

export interface ShadowAgreementSlice {
  judged: number;
  jev_answered: number;
  jev_failed: number;
  incumbent_insufficient: number;
  incumbent_unparseable_ballots: number;
  confusion: AgreementAccum["confusion"];
  agreedCount: number;
  disagreedCount: number;
  agreement_denominator: number;
  agreementRate: number | null;
  p_gap_mean: number | null;
  total_input_tokens: number;
  total_usd: number;
  bodies_truncated: number;
}

export interface ShadowReplayReport extends ShadowAgreementSlice {
  db_path: string;
  degraded_window: DegradedWindow;
  since: string | null;
  total_eligible: number;
  unlabelled: number;
  excluded_degraded: number;
  excluded_no_timestamp: number;
  max_rollups: number | null;
  max_usd: number;
  projected_stop: boolean;
  current_claim_eligible: ShadowAgreementSlice;
  claim_excluded_rows: number;
}

interface AgreementAccum {
  jevAnswered: number;
  jevFailed: number;
  incumbentInsufficient: number;
  incumbentUnparseable: number;
  bodiesTruncated: number;
  confusion: { both_promote: number; incumbent_only: number; jev_only: number; neither: number };
  agreedCount: number;
  disagreedCount: number;
  pGapSum: number;
  pGapCount: number;
  totalInputTokens: number;
  totalUsd: number;
}

type ConfusionKey = keyof AgreementAccum["confusion"];

function confusionKeyFor(incumbentPromotes: boolean, shadowPromote: boolean): ConfusionKey {
  if (incumbentPromotes) {
    return shadowPromote ? "both_promote" : "incumbent_only";
  }
  return shadowPromote ? "jev_only" : "neither";
}

function recordRow(acc: AgreementAccum, row: ShadowEvalRowResult): void {
  if (row.incumbentDecision === "insufficient") {
    acc.incumbentInsufficient += 1;
  }
  acc.incumbentUnparseable += row.incumbentUnparseable;
  acc.bodiesTruncated += Number(row.bodyTruncated);
  if (row.jev.status === "failed") {
    acc.jevFailed += 1;
    return;
  }
  if (row.jev.status === "skipped") {
    return;
  }
  acc.jevAnswered += 1;
  acc.totalInputTokens += row.jev.inputTokens;
  acc.totalUsd += row.jev.usd;
  if (row.incumbentDecision === "insufficient") {
    return;
  }
  const incumbentPromotes = row.incumbentDecision === "promote";
  acc.confusion[confusionKeyFor(incumbentPromotes, row.jev.shadowPromote)] += 1;
  if (incumbentPromotes === row.jev.shadowPromote) {
    acc.agreedCount += 1;
  } else {
    acc.disagreedCount += 1;
  }
  if (row.incumbentPYes !== null) {
    acc.pGapSum += Math.abs(row.incumbentPYes - row.jev.pPromote);
    acc.pGapCount += 1;
  }
}

function newAgreementAccum(): AgreementAccum {
  return {
    jevAnswered: 0,
    jevFailed: 0,
    incumbentInsufficient: 0,
    incumbentUnparseable: 0,
    bodiesTruncated: 0,
    agreedCount: 0,
    disagreedCount: 0,
    pGapSum: 0,
    pGapCount: 0,
    totalInputTokens: 0,
    totalUsd: 0,
    confusion: { both_promote: 0, incumbent_only: 0, jev_only: 0, neither: 0 },
  };
}

function sliceFromAccum(acc: AgreementAccum, judged: number): ShadowAgreementSlice {
  const compared = acc.agreedCount + acc.disagreedCount;
  return {
    judged,
    jev_answered: acc.jevAnswered,
    jev_failed: acc.jevFailed,
    incumbent_insufficient: acc.incumbentInsufficient,
    incumbent_unparseable_ballots: acc.incumbentUnparseable,
    confusion: acc.confusion,
    agreedCount: acc.agreedCount,
    disagreedCount: acc.disagreedCount,
    agreement_denominator: compared,
    agreementRate: compared > 0 ? acc.agreedCount / compared : null,
    p_gap_mean: acc.pGapCount > 0 ? acc.pGapSum / acc.pGapCount : null,
    total_input_tokens: acc.totalInputTokens,
    total_usd: acc.totalUsd,
    bodies_truncated: acc.bodiesTruncated,
  };
}

export function summarizeAgreement(
  meta: ShadowReplayMeta,
  rows: readonly ShadowEvalRowResult[],
): ShadowReplayReport {
  const acc = newAgreementAccum();
  const eligibleAcc = newAgreementAccum();
  for (const row of rows) {
    recordRow(acc, row);
    if (row.claimEligible) {
      recordRow(eligibleAcc, row);
    }
  }
  const eligibleJudged = rows.filter((row) => row.claimEligible).length;
  return {
    db_path: meta.dbPath,
    degraded_window: meta.degradedWindow,
    since: meta.since,
    total_eligible: meta.totalEligible,
    unlabelled: meta.unlabelled,
    excluded_degraded: meta.excludedDegraded,
    excluded_no_timestamp: meta.excludedNoTimestamp,
    ...sliceFromAccum(acc, rows.length),
    max_rollups: meta.maxRollups,
    max_usd: meta.maxUsd,
    projected_stop: meta.projectedStop,
    current_claim_eligible: sliceFromAccum(eligibleAcc, eligibleJudged),
    claim_excluded_rows: rows.length - eligibleJudged,
  };
}

export interface ShadowEvalDeps {
  fetch: TypesafeFetch;
  settings?: TypesafeSettings;
  maxRetries?: number;
}

interface JevFields {
  answers: PromotionAnswers | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  outcome: ShadowEvalRowResult["jev"];
}

const SKIPPED_JEV: JevFields = {
  answers: null,
  model: null,
  usage: null,
  outcome: { status: "skipped" },
};

async function judgeCandidate(client: TypesafeClient, body: string): Promise<JevFields> {
  const outcome = await judgePromotion(
    client,
    { kind: "promote_t1", body },
    AbortSignal.timeout(15_000),
  );
  if (!outcome.ok) {
    return { answers: null, model: null, usage: null, outcome: { status: "failed" } };
  }
  const { judgement } = outcome;
  return {
    answers: judgement.answers,
    model: judgement.model,
    usage: judgement.usage,
    outcome: {
      status: "answered",
      pPromote: judgement.pPromote,
      shadowPromote: judgement.shadowPromote,
      inputTokens: judgement.usage.inputTokens,
      usd: judgement.usd,
    },
  };
}

type LiveBudget = { sent: number; spentUsd: number; projectedStop: boolean };

async function judgeWithinBudget(
  client: TypesafeClient,
  body: string,
  maxUsd: number,
  budget: LiveBudget,
): Promise<{ judged: JevFields; bodyTruncated: boolean }> {
  const sendBody = body.slice(0, MAX_LIVE_BODY_CHARS);
  const estimateUsd = estimateLiveRequestUsd(sendBody);
  if (budget.spentUsd + estimateUsd > maxUsd) {
    budget.projectedStop = true;
    return { judged: SKIPPED_JEV, bodyTruncated: false };
  }
  const judged = await judgeCandidate(client, sendBody);
  budget.sent += 1;
  // A failed call may still have been billed; spend the estimate.
  budget.spentUsd += judged.outcome.status === "answered" ? judged.outcome.usd : estimateUsd;
  return { judged, bodyTruncated: sendBody.length !== body.length };
}

function requireEnabledSettings(
  settings: TypesafeSettings | undefined,
): Extract<TypesafeSettings, { enabled: true }> {
  if (!settings?.enabled) {
    throw new Error("typesafe-shadow-eval: --live requires enabled TypeSafe settings");
  }
  return settings;
}

export async function runShadowEval(
  args: ShadowEvalArgs,
  deps: ShadowEvalDeps,
): Promise<ShadowReplayReport> {
  if (args.live && args.maxRollups === null) {
    throw new Error("typesafe-shadow-eval: --live requires --max-rollups");
  }
  const db = openReplayDb(args.dbPath);
  let loaded: LoadedReplay;
  try {
    loaded = loadReplayRollups(db, {
      sinceMs: args.since === null ? null : Date.parse(args.since),
      degradedFromMs: Date.parse(args.degradedWindow.from),
      degradedToMs: Date.parse(args.degradedWindow.to),
      limit: args.limit,
    });
  } finally {
    db.close();
  }

  const client = args.live
    ? createTypesafeClient({
        settings: requireEnabledSettings(deps.settings),
        fetch: deps.fetch,
        maxRetries: deps.maxRetries,
      })
    : null;

  const budget: LiveBudget = { sent: 0, spentUsd: 0, projectedStop: false };

  const results: ShadowEvalRowResult[] = [];
  const lines: string[] = [];
  for (const candidate of loaded.rows) {
    const incumbent = incumbentFromBallots({
      ballots: candidate.ballots,
      storedConfidence: candidate.storedConfidence,
    });
    let judged = SKIPPED_JEV;
    let bodyTruncated = false;
    if (client !== null && (args.maxRollups === null || budget.sent < args.maxRollups)) {
      const attempt = await judgeWithinBudget(client, candidate.body, args.maxUsd, budget);
      judged = attempt.judged;
      bodyTruncated = attempt.bodyTruncated;
    }
    const claimEligible = isClaimEligibleRollup(candidate.body, candidate.userId);
    lines.push(
      `${JSON.stringify({
        rollup_id: candidate.rollupId,
        incumbent_ballots: incumbent.ballots,
        incumbent_decision: incumbent.decision,
        jev_answers: judged.answers,
        model: judged.model,
        usage: judged.usage,
        claim_eligible: claimEligible,
      })}\n`,
    );
    results.push({
      incumbentDecision: incumbent.decision,
      incumbentPYes: incumbent.pYes,
      incumbentUnparseable: incumbent.unparseable,
      bodyTruncated,
      claimEligible,
      jev: judged.outcome,
    });
  }
  writeFileSync(args.outPath, lines.join(""));

  return summarizeAgreement(
    {
      dbPath: args.dbPath,
      degradedWindow: args.degradedWindow,
      since: args.since,
      totalEligible: loaded.totalEligible,
      unlabelled: loaded.unlabelled,
      excludedDegraded: loaded.excludedDegraded,
      excludedNoTimestamp: loaded.excludedNoTimestamp,
      maxRollups: args.maxRollups,
      maxUsd: args.maxUsd,
      projectedStop: budget.projectedStop,
    },
    results,
  );
}

const liveFetch: TypesafeFetch = (url, init) => globalThis.fetch(url, init);

async function main(): Promise<number> {
  const args = parseShadowEvalArgs(process.argv.slice(2));
  let settings: TypesafeSettings | undefined;
  if (args.live) {
    settings = resolveTypesafeSettings(getConfig(process.env).env as unknown as TypesafeEnvInput);
    if (!settings.enabled) {
      process.stderr.write(`${settings.reason}\n`);
      return 2;
    }
  }
  const deps: ShadowEvalDeps =
    settings === undefined ? { fetch: liveFetch } : { fetch: liveFetch, settings };
  const report = await runShadowEval(args, deps);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
