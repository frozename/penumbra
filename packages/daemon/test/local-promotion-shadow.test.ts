import type { TypesafeClient } from "@penumbra/typesafe";

import { expect, test } from "bun:test";

import { createLocalPromotionShadowSeat } from "../src/dreaming/local-promotion-shadow.js";
import { composeShadowJudgePool } from "../src/dreaming/typesafe-judge-seat.js";

const client: TypesafeClient = {
  evaluate: () => Promise.resolve({ ok: false, kind: "timeout", status: null, attempts: 1 }),
};

test("candidate failure and sink failure cannot change incumbent votes", async () => {
  const votes = [{ promote: true, confidence: 0.8, seat: "incumbent" }];
  const pool = {
    judge: (): ReturnType<import("../src/dreaming/judge-pool.js").JudgePool["judge"]> =>
      Promise.resolve({ confidence: 0.8, verdict: "yes" as const }),
    judgeAll: (): Promise<import("../src/dreaming/judge-pool.js").JudgeVote[]> =>
      Promise.resolve(votes),
  };
  const seat = createLocalPromotionShadowSeat({
    client,
    revision: "sha",
    writeDecision: () => {
      throw new Error("sink failed");
    },
  });
  const composed = composeShadowJudgePool(pool, seat);
  expect(
    await composed.judgeAll?.({ body: "a candidate", kind: "promote_t1", subjectId: "x" }),
  ).toBe(votes);
  expect(await composed.judge({ body: "a candidate", kind: "link" })).toEqual({
    confidence: 0.8,
    verdict: "yes",
  });
});

test("shadow evaluation returns without waiting for a hung candidate", async () => {
  const pool = {
    judge: (): ReturnType<import("../src/dreaming/judge-pool.js").JudgePool["judge"]> =>
      Promise.resolve({ confidence: 1, verdict: "no" as const }),
    judgeAll: (): Promise<import("../src/dreaming/judge-pool.js").JudgeVote[]> =>
      Promise.resolve([{ promote: false, confidence: 1 }]),
  };
  const hung: TypesafeClient = {
    evaluate: () =>
      new Promise(() => {
        /* Simulate a broken transport. */
      }),
  };
  const composed = composeShadowJudgePool(
    pool,
    createLocalPromotionShadowSeat({
      client: hung,
      budgetMs: 20,
      revision: "sha",
      writeDecision: () => undefined,
    }),
  );
  expect(
    await composed.judgeAll?.({ body: "task prompt", kind: "promote_t1", subjectId: "x" }),
  ).toEqual([{ promote: false, confidence: 1 }]);
});

test("successful disagreement is recorded only in a shadow sink with hashed input", async () => {
  const { createLocalDecisionClient } = await import("@penumbra/typesafe");
  const recorded: unknown[] = [];
  const local = createLocalDecisionClient({
    baseUrl: "http://127.0.0.1:18944",
    model: "pinned",
    revision: "sha256",
    fetch: () =>
      Promise.resolve(
        Response.json({
          model: "pinned",
          answers: { promote: { type: "noul", noul: 0.1 } },
          usage: { input_tokens: 20, output_tokens: 0 },
        }),
      ),
  });
  const seat = createLocalPromotionShadowSeat({
    client: local,
    revision: "sha256",
    writeDecision: (row) => {
      recorded.push(row);
    },
  });
  const votes = [{ promote: true, confidence: 0.9 }];
  await seat.shadow(
    { body: "untrusted input", kind: "promote_t1", subjectId: "x" },
    Promise.resolve(votes),
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    mode: "shadow",
    applied: false,
    candidatePromote: false,
    probability: 0.1,
    incumbentVotes: votes,
    failure: null,
  });
  expect(JSON.stringify(recorded)).not.toContain("untrusted input");
  expect(votes).toEqual([{ promote: true, confidence: 0.9 }]);
});

test("a diagnostics sink receives copies and cannot rewrite incumbent ballots", async () => {
  const { createLocalDecisionClient } = await import("@penumbra/typesafe");
  const local = createLocalDecisionClient({
    baseUrl: "http://127.0.0.1:18944",
    model: "pinned",
    revision: "sha",
    fetch: () =>
      Promise.resolve(
        Response.json({
          model: "pinned",
          answers: { promote: { type: "noul", noul: 0.1 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      ),
  });
  const votes = [{ promote: true, confidence: 1 }];
  const seat = createLocalPromotionShadowSeat({
    client: local,
    revision: "sha",
    writeDecision: (row) => {
      if (row.incumbentVotes?.[0]) row.incumbentVotes[0].promote = false;
    },
  });
  await seat.shadow(
    { body: "untrusted", kind: "promote_t1", subjectId: "x" },
    Promise.resolve(votes),
  );
  expect(votes[0]?.promote).toBe(true);
});

test("shadow requests only the direct bounded decision", async () => {
  let ids: string[] = [];
  const local: TypesafeClient = {
    evaluate: (req) => {
      ids = Object.keys(req.questions);
      return Promise.resolve({ ok: false, kind: "timeout", status: null, attempts: 1 });
    },
  };
  const seat = createLocalPromotionShadowSeat({
    client: local,
    revision: "sha",
    writeDecision: () => undefined,
  });
  await seat.shadow({ body: "untrusted", kind: "promote_t1", subjectId: "x" }, Promise.resolve([]));
  expect(ids).toEqual(["promote"]);
});

test("a hung incumbent cannot retain the detached shadow indefinitely", async () => {
  const recorded: unknown[] = [];
  const seat = createLocalPromotionShadowSeat({
    client,
    budgetMs: 20,
    revision: "sha",
    writeDecision: (row) => {
      recorded.push(row);
    },
  });
  await seat.shadow(
    { body: "input", kind: "promote_t1", subjectId: "x" },
    new Promise(() => undefined),
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ incumbentVotes: null, failure: "timeout", applied: false });
});

test("candidate deadline preserves incumbent ballots that already resolved", async () => {
  const votes = [{ promote: true, confidence: 0.9, seat: "incumbent" }];
  const recorded: unknown[] = [];
  const seat = createLocalPromotionShadowSeat({
    client: { evaluate: () => new Promise(() => undefined) },
    budgetMs: 20,
    revision: "sha",
    writeDecision: (row) => recorded.push(row),
  });
  await seat.shadow({ body: "input", kind: "promote_t1", subjectId: "x" }, Promise.resolve(votes));
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    incumbentVotes: votes,
    failure: "timeout",
    candidatePromote: null,
    probability: null,
    mode: "shadow",
    applied: false,
  });
  expect(votes).toEqual([{ promote: true, confidence: 0.9, seat: "incumbent" }]);
});
