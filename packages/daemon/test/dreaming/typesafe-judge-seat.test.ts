import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  type JudgePool,
  type JudgeVote,
  makeFakeJudgePool,
  StubJudgePool,
} from "@src/dreaming/judge-pool.js";
import {
  composeShadowJudgePool,
  createTypesafeShadowSeat,
  isShadowComposedPool,
  type JevShadowDecision,
  type JevShadowJudge,
  type JevShadowJudgeLoader,
  type JevShadowJudgement,
  type JevShadowOutcome,
  TYPESAFE_SHADOW_SUBSYSTEM,
  type TypesafeShadowSeat,
} from "@src/dreaming/typesafe-judge-seat.js";
import { computeSubsystemAlerts, readSubsystemHealth } from "@src/services/subsystem-health.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

const FIXED_NOW_MS = 1_769_904_000_000; // 2026-02-01T00:00:00.000Z
const B = "SHADOW-BODY-7f3a9 durable knowledge about deploy ordering";
const VOTES: JudgeVote[] = [
  { promote: true, confidence: 0.9 },
  { promote: false, confidence: 0.4 },
];

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function okJudgement(overrides?: Partial<JevShadowJudgement>): JevShadowJudgement {
  return {
    model: "jev-1.2.3",
    answers: { promote: 0.87 },
    pPromote: 0.87,
    shadowPromote: true,
    usage: { inputTokens: 1234, outputTokens: 56 },
    usd: 0.0042,
    ...overrides,
  };
}

function judgeReturning(outcome: JevShadowOutcome): JevShadowJudge {
  return () => Promise.resolve(outcome);
}

const okJudge = judgeReturning({ ok: true, judgement: okJudgement() });

function makeSeat(
  db: Database,
  opts: {
    loadJudge?: JevShadowJudgeLoader;
    writeDecision?: (row: JevShadowDecision) => void;
    budgetMs?: number;
  },
): { seat: TypesafeShadowSeat; decisions: JevShadowDecision[] } {
  const decisions: JevShadowDecision[] = [];
  const seat = createTypesafeShadowSeat({
    db,
    loadJudge: opts.loadJudge ?? ((): Promise<JevShadowJudge> => Promise.resolve(okJudge)),
    writeDecision:
      opts.writeDecision ??
      ((row): void => {
        decisions.push(row);
      }),
    ...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
    now: () => FIXED_NOW_MS,
  });
  return { seat, decisions };
}

describe("composeShadowJudgePool", () => {
  it("returns a pool without judgeAll back by identity, untouched", () => {
    const db = openTestDb();
    const { seat } = makeSeat(db, {});
    const stub = new StubJudgePool();
    const result = composeShadowJudgePool(stub, seat);
    expect(result).toBe(stub);
    expect("judgeAll" in result).toBe(false);
    expect(isShadowComposedPool(result)).toBe(false);
  });

  it("returns the incumbent ballots by identity and shadows only {kind, body}", async () => {
    const db = openTestDb();
    let seen: { kind: string; body: string } | undefined;
    const spyJudge: JevShadowJudge = (input) => {
      seen = input;
      return Promise.resolve({ ok: true, judgement: okJudgement() });
    };
    const { seat } = makeSeat(db, { loadJudge: () => Promise.resolve(spyJudge) });
    const composite = composeShadowJudgePool(makeFakeJudgePool(VOTES), seat);
    expect(isShadowComposedPool(composite)).toBe(true);
    const result = await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    expect(result).toBe(VOTES);
    expect(seen).toEqual({ kind: "promote_t1", body: B });
  });

  it("propagates an incumbent rejection by identity while the shadow still settles", async () => {
    const db = openTestDb();
    const E = new Error("incumbent exploded");
    const incumbent: JudgePool = {
      judge: () => Promise.reject(E),
      judgeAll: () => Promise.reject(E),
    };
    const { seat, decisions } = makeSeat(db, {});
    const composite = composeShadowJudgePool(incumbent, seat);
    const err = await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(E);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.incumbentVotes).toBeNull();
  });
});

describe("typesafe shadow seat failures", () => {
  it("records error/rate_limited outcomes without touching ballots or the abstain alert", async () => {
    const dbThrow = openTestDb();
    const throwingJudge: JevShadowJudge = () => Promise.reject(new Error("jev down"));
    const { seat: seatThrow, decisions: decisionsThrow } = makeSeat(dbThrow, {
      loadJudge: () => Promise.resolve(throwingJudge),
    });
    const compositeThrow = composeShadowJudgePool(makeFakeJudgePool(VOTES), seatThrow);
    const resultThrow = await compositeThrow.judgeAll!({
      body: B,
      kind: "promote_t1",
      subjectId: "r1",
    });
    expect(resultThrow).toBe(VOTES);
    const healthThrow = readSubsystemHealth(dbThrow, TYPESAFE_SHADOW_SUBSYSTEM);
    expect(healthThrow?.consecutive_failures).toBe(1);
    expect(healthThrow?.last_failure_reason).toBe("error");
    expect(decisionsThrow).toHaveLength(0);

    const dbRate = openTestDb();
    const { seat: seatRate, decisions: decisionsRate } = makeSeat(dbRate, {
      loadJudge: () =>
        Promise.resolve(judgeReturning({ ok: false, reason: "rate_limited", status: 429 })),
    });
    const compositeRate = composeShadowJudgePool(makeFakeJudgePool(VOTES), seatRate);
    await compositeRate.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    const healthRate = readSubsystemHealth(dbRate, TYPESAFE_SHADOW_SUBSYSTEM);
    expect(healthRate?.last_failure_reason).toBe("rate_limited");
    expect(healthRate?.last_failure_status).toBe(429);
    expect(decisionsRate).toHaveLength(0);

    const dbAlert = openTestDb();
    const { seat: seatAlert } = makeSeat(dbAlert, {
      loadJudge: () =>
        Promise.resolve(judgeReturning({ ok: false, reason: "rate_limited", status: 429 })),
    });
    const compositeAlert = composeShadowJudgePool(makeFakeJudgePool(VOTES), seatAlert);
    for (const _ of [1, 2, 3, 4, 5]) {
      await compositeAlert.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    }
    const healthAlert = readSubsystemHealth(dbAlert, TYPESAFE_SHADOW_SUBSYSTEM);
    expect(healthAlert?.consecutive_failures).toBe(5);
    const alerts = computeSubsystemAlerts(dbAlert, { now: new Date() });
    expect(alerts.some((a) => a.startsWith("dream.health.judge_abstaining."))).toBe(false);
  });

  it("returns on the ballot budget when the judge never settles", async () => {
    const db = openTestDb();
    const neverJudge: JevShadowJudge = () => new Promise<JevShadowOutcome>(() => undefined);
    const { seat, decisions } = makeSeat(db, {
      loadJudge: () => Promise.resolve(neverJudge),
      budgetMs: 20,
    });
    const composite = composeShadowJudgePool(makeFakeJudgePool(VOTES), seat);
    const result = await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    expect(result).toBe(VOTES);
    const health = readSubsystemHealth(db, TYPESAFE_SHADOW_SUBSYSTEM);
    expect(health?.last_failure_reason).toBe("timeout");
    expect(decisions).toHaveLength(0);
  });

  it("a disabled loader records nothing at all", async () => {
    const db = openTestDb();
    let loads = 0;
    const { seat, decisions } = makeSeat(db, {
      loadJudge: () => {
        loads += 1;
        return Promise.resolve({ disabled: "no_key" });
      },
    });
    const composite = composeShadowJudgePool(makeFakeJudgePool(VOTES), seat);
    await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    expect(loads).toBe(1);
    expect(decisions).toHaveLength(0);
    expect(readSubsystemHealth(db, TYPESAFE_SHADOW_SUBSYSTEM)).toBeNull();
  });

  it("a throwing writeDecision records sink_error and never reaches the ballots", async () => {
    const db = openTestDb();
    const { seat } = makeSeat(db, {
      writeDecision: () => {
        throw new Error("disk full");
      },
    });
    const composite = composeShadowJudgePool(makeFakeJudgePool(VOTES), seat);
    const result = await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    expect(result).toBe(VOTES);
    const health = readSubsystemHealth(db, TYPESAFE_SHADOW_SUBSYSTEM);
    expect(health?.last_failure_reason).toBe("sink_error");
  });
});

describe("typesafe shadow seat decisions", () => {
  it("writes exactly one decision row carrying the hash, not the body", async () => {
    const db = openTestDb();
    const judgement = okJudgement();
    const { seat, decisions } = makeSeat(db, {
      loadJudge: () => Promise.resolve(judgeReturning({ ok: true, judgement })),
    });
    const composite = composeShadowJudgePool(makeFakeJudgePool(VOTES), seat);
    await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    expect(decisions).toHaveLength(1);
    const row = decisions[0]!;
    expect(row.site).toBe("dream.p1.promotion");
    expect(row.subjectId).toBe("r1");
    expect(row.inputSha256).toBe(createHash("sha256").update(B).digest("hex"));
    expect(row.createdAt).toBe(new Date(FIXED_NOW_MS).toISOString());
    expect(row.model).toBe(judgement.model);
    expect(row.answers).toEqual(judgement.answers);
    expect(row.pPromote).toBe(judgement.pPromote);
    expect(row.shadowPromote).toBe(judgement.shadowPromote);
    expect(row.usd).toBe(judgement.usd);
    expect(row.usage).toEqual(judgement.usage);
    expect(row.incumbentVotes).toBe(VOTES);
    expect(row.latencyMs).toBe(0);
    expect(JSON.stringify(row)).not.toContain(B);
  });

  it("a success after a failure resets consecutive_failures", async () => {
    const db = openTestDb();
    let fail = true;
    const flipJudge: JevShadowJudge = () =>
      Promise.resolve(
        fail
          ? { ok: false, reason: "server", status: 500 }
          : { ok: true, judgement: okJudgement() },
      );
    const { seat } = makeSeat(db, { loadJudge: () => Promise.resolve(flipJudge) });
    const composite = composeShadowJudgePool(makeFakeJudgePool(VOTES), seat);
    await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r1" });
    expect(readSubsystemHealth(db, TYPESAFE_SHADOW_SUBSYSTEM)?.consecutive_failures).toBe(1);
    fail = false;
    await composite.judgeAll!({ body: B, kind: "promote_t1", subjectId: "r2" });
    expect(readSubsystemHealth(db, TYPESAFE_SHADOW_SUBSYSTEM)?.consecutive_failures).toBe(0);
  });

  it("never loads the judge for non-promote kinds or promote ballots without a subject", async () => {
    const db = openTestDb();
    let loads = 0;
    const { seat, decisions } = makeSeat(db, {
      loadJudge: () => {
        loads += 1;
        return Promise.resolve(okJudge);
      },
    });
    const composite = composeShadowJudgePool(makeFakeJudgePool(VOTES), seat);
    await composite.judgeAll!({ body: B, kind: "link", subjectId: "r1" });
    await composite.judgeAll!({ body: B, kind: "promote_t1" });
    expect(loads).toBe(0);
    expect(decisions).toHaveLength(0);
  });
});
