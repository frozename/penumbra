import type { Database } from "bun:sqlite";

import { createHash } from "node:crypto";

import type { DreamCostMeter } from "./cycle.js";
import type { JudgePool, JudgeVote } from "./judge-pool.js";

import { recordSubsystemOutcome } from "../services/subsystem-health.js";

export const TYPESAFE_SHADOW_SEAT = "typesafe-jev";
// Deliberately OUTSIDE the "dream.judge." prefix: the Task 1.1 abstain alert
// must never count a shadow seat.
export const TYPESAFE_SHADOW_SUBSYSTEM = "dream.shadow.typesafe-jev";
export const P1_PROMOTION_JUDGE_SITE = "dream.p1.promotion";
// Deliberately not "P1": a refusal lands this phase in ctx.deferredPhases and a
// later record() removes it, and only "P3" reads that set today — but a bare
// "P1" would let a shadow refusal look like a P1 deferral to any future reader.
export const JEV_SHADOW_COST_PHASE = "P1.shadow";
// Total per-ballot budget; equals the in-house client's TOTAL deadline default
// (PENUMBRA_TYPESAFE_TIMEOUT_MS = 10000), which already bounds every attempt,
// backoff and Retry-After sleep.
export const JEV_SHADOW_BUDGET_MS = 10_000;

export interface JevShadowJudgement {
  model: string;
  answers: Record<string, number>;
  pPromote: number;
  shadowPromote: boolean;
  usage: { inputTokens: number; outputTokens: number };
  usd: number;
}

export type JevShadowOutcome =
  | { ok: true; judgement: JevShadowJudgement }
  | { ok: false; reason: string; status: number | null };

export type JevShadowJudge = (
  input: { kind: string; body: string },
  signal: AbortSignal,
) => Promise<JevShadowOutcome>;

export type JevShadowJudgeLoader = () => Promise<JevShadowJudge | { disabled: string }>;

export interface JevShadowDecision {
  site: typeof P1_PROMOTION_JUDGE_SITE;
  subjectId: string;
  inputSha256: string;
  createdAt: string;
  model: string;
  answers: Record<string, number>;
  pPromote: number;
  shadowPromote: boolean;
  incumbentVotes: JudgeVote[] | null;
  usage: JevShadowJudgement["usage"];
  usd: number;
  latencyMs: number;
}

export interface TypesafeShadowSeatDeps {
  db: Database;
  loadJudge: JevShadowJudgeLoader;
  writeDecision: (row: JevShadowDecision) => void;
  getCostMeter: () => DreamCostMeter | undefined;
  estimateUsd: number;
  budgetMs?: number;
  now?: () => number;
}

export interface TypesafeShadowSeat {
  shadow(
    args: { body: string; kind: string; subjectId: string },
    incumbent: Promise<JudgeVote[] | null>,
  ): Promise<void>;
}

const COMPOSED_POOLS = new WeakSet<JudgePool>();

const IN_FLIGHT_SHADOWS = new Set<Promise<void>>();

export async function drainShadowJudgements(timeoutMs: number): Promise<void> {
  await Promise.race([
    (async (): Promise<void> => {
      for (;;) {
        const pending = [...IN_FLIGHT_SHADOWS];
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    })(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

interface SeatRuntime {
  deps: TypesafeShadowSeatDeps;
  budgetMs: number;
  now: () => number;
}

interface SeatOutcomeRecord {
  model: string | null;
  ok: boolean | "skip";
  reason: string | null;
  status: number | null;
}

export function createTypesafeShadowSeat(deps: TypesafeShadowSeatDeps): TypesafeShadowSeat {
  // A non-positive estimate makes canAfford unconditionally true (the meter
  // returns early for usd <= 0), which would leave the gate permanently open.
  if (!(deps.estimateUsd > 0)) {
    throw new Error("typesafe shadow seat requires a positive estimateUsd");
  }
  const rt: SeatRuntime = {
    deps,
    budgetMs: deps.budgetMs ?? JEV_SHADOW_BUDGET_MS,
    now: deps.now ?? Date.now,
  };
  return {
    shadow: (args, incumbent) => runShadow(rt, args, incumbent),
  };
}

function recordOutcome(db: Database, outcome: SeatOutcomeRecord): void {
  recordSubsystemOutcome(db, {
    subsystem: TYPESAFE_SHADOW_SUBSYSTEM,
    tier: "primary",
    seat: TYPESAFE_SHADOW_SEAT,
    host: "api.typesafe.ai",
    model: outcome.model,
    ok: outcome.ok,
    reason: outcome.reason,
    status: outcome.status,
  });
}

async function loadSeatJudge(rt: SeatRuntime): Promise<JevShadowJudge | null> {
  try {
    const loaded = await rt.deps.loadJudge();
    // A { disabled } result records nothing: no health row, no decision.
    return typeof loaded === "function" ? loaded : null;
  } catch {
    recordOutcome(rt.deps.db, { model: null, ok: false, reason: "error", status: null });
    return null;
  }
}

async function callJudgeWithinBudget(
  judge: JevShadowJudge,
  input: { kind: string; body: string },
  budgetMs: number,
): Promise<JevShadowOutcome> {
  const signal = AbortSignal.timeout(budgetMs);
  const judged = Promise.resolve()
    .then(() => judge(input, signal))
    .then(
      (outcome) => outcome,
      (): JevShadowOutcome => ({ ok: false, reason: "error", status: null }),
    );
  const budget = new Promise<JevShadowOutcome>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve({ ok: false, reason: "timeout", status: null });
      },
      { once: true },
    );
  });
  return await Promise.race([judged, budget]);
}

function writeShadowDecision(
  rt: SeatRuntime,
  args: { body: string; subjectId: string },
  judgement: JevShadowJudgement,
  incumbentVotes: JudgeVote[] | null,
  startedMs: number,
): void {
  try {
    rt.deps.writeDecision({
      site: P1_PROMOTION_JUDGE_SITE,
      subjectId: args.subjectId,
      inputSha256: createHash("sha256").update(args.body).digest("hex"),
      createdAt: new Date(rt.now()).toISOString(),
      model: judgement.model,
      answers: judgement.answers,
      pPromote: judgement.pPromote,
      shadowPromote: judgement.shadowPromote,
      incumbentVotes,
      usage: judgement.usage,
      usd: judgement.usd,
      latencyMs: rt.now() - startedMs,
    });
  } catch {
    recordOutcome(rt.deps.db, {
      model: judgement.model,
      ok: false,
      reason: "sink_error",
      status: null,
    });
    return;
  }
  recordOutcome(rt.deps.db, { model: judgement.model, ok: true, reason: null, status: null });
}

async function runShadow(
  rt: SeatRuntime,
  args: { body: string; kind: string; subjectId: string },
  incumbent: Promise<JudgeVote[] | null>,
): Promise<void> {
  const judge = await loadSeatJudge(rt);
  if (judge === null) return;
  const meter = rt.deps.getCostMeter();
  // No meter means the cycle cannot bill the call: skip rather than judge free.
  if (meter === undefined) {
    recordOutcome(rt.deps.db, { model: null, ok: "skip", reason: null, status: null });
    return;
  }
  // A refusal only skips the uncounted shadow ballot: deferring would let Jev's
  // budget move incumbent promotion timing.
  if (!meter.canAfford(JEV_SHADOW_COST_PHASE, "llm", rt.deps.estimateUsd)) {
    recordOutcome(rt.deps.db, { model: null, ok: "skip", reason: null, status: null });
    return;
  }
  const startedMs = rt.now();
  const outcome = await callJudgeWithinBudget(
    judge,
    { kind: args.kind, body: args.body },
    rt.budgetMs,
  );
  if (!outcome.ok) {
    // The request may have been billed, so fail toward the cap at the estimate.
    meter.record(JEV_SHADOW_COST_PHASE, "llm", rt.deps.estimateUsd);
    recordOutcome(rt.deps.db, {
      model: null,
      ok: false,
      reason: outcome.reason,
      status: outcome.status,
    });
    return;
  }
  meter.record(JEV_SHADOW_COST_PHASE, "llm", outcome.judgement.usd);
  const incumbentVotes = await incumbent.then(
    (votes) => votes,
    () => null,
  );
  writeShadowDecision(rt, args, outcome.judgement, incumbentVotes, startedMs);
}

export function composeShadowJudgePool(incumbent: JudgePool, seat: TypesafeShadowSeat): JudgePool {
  if (!incumbent.judgeAll) return incumbent;
  const incumbentJudgeAll = incumbent.judgeAll.bind(incumbent);
  const pool: JudgePool = {
    judge: (args) => incumbent.judge(args),
    judgeAll: async (args) => {
      const votes = incumbentJudgeAll(args);
      const subjectId = args.subjectId;
      if (args.kind === "promote_t1" && subjectId !== undefined) {
        const shadowDone: Promise<void> = seat
          .shadow(
            { body: args.body, kind: args.kind, subjectId },
            votes.then(
              (v) => v,
              () => null,
            ),
          )
          .catch(() => undefined);
        IN_FLIGHT_SHADOWS.add(shadowDone);
        void shadowDone.then(() => {
          IN_FLIGHT_SHADOWS.delete(shadowDone);
        });
      }
      return await votes;
    },
  };
  COMPOSED_POOLS.add(pool);
  return pool;
}

export function isShadowComposedPool(pool: JudgePool): boolean {
  return COMPOSED_POOLS.has(pool);
}
