import { expect, test } from "bun:test";

import type { PromotionAnswers, PromotionClient } from "../src/questions/promotion.js";

import {
  derivePromoteProbability,
  judgePromotion,
  PROMOTION_PINNED_MODEL_ID,
  PROMOTION_QUESTION_IDS,
  promotionUsdForInputTokens,
} from "../src/questions/promotion.js";

const INPUT = { kind: "promote_t1", body: "promotion validation fixture body" };
const SIGNAL = new AbortController().signal;

type NoulVector = [number, number, number, number];

function answersRecord(nouls: NoulVector): PromotionAnswers {
  const [durable, ephemeral, artifact, discoverable] = nouls;
  return {
    is_durable_fact_worth_keeping: durable,
    is_ephemeral_runtime_noise: ephemeral,
    is_prompt_or_task_artifact: artifact,
    is_mechanically_discoverable_from_the_repo: discoverable,
  };
}

function noulAnswers(nouls: NoulVector): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [index, id] of PROMOTION_QUESTION_IDS.entries()) {
    answers[id] = { type: "noul", noul: nouls[index] ?? 0 };
  }
  return answers;
}

function okEnvelope(
  answers: unknown,
  options?: {
    model?: string;
    usage?: unknown;
    attempts?: number;
  },
): unknown {
  return {
    ok: true,
    model: options?.model ?? PROMOTION_PINNED_MODEL_ID,
    answers,
    usage: options?.usage === undefined ? { inputTokens: 312, outputTokens: 48 } : options.usage,
    attempts: options?.attempts ?? 1,
  };
}

function fakeClient(envelope: unknown): PromotionClient {
  return {
    evaluate: (): Promise<unknown> => Promise.resolve(envelope),
  } as unknown as PromotionClient;
}

test("a null answers value maps to malformed", async () => {
  const outcome = await judgePromotion(fakeClient(okEnvelope(null)), INPUT, SIGNAL);
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("an answer entry with a non-noul type maps to malformed", async () => {
  const answers = noulAnswers([1, 0.5, 0, 0]);
  answers["is_ephemeral_runtime_noise"] = { type: "score", noul: 0.5 };
  const outcome = await judgePromotion(fakeClient(okEnvelope(answers)), INPUT, SIGNAL);
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("an answer entry with a numeric-string noul maps to malformed", async () => {
  const answers = noulAnswers([1, 0.5, 0, 0]);
  answers["is_ephemeral_runtime_noise"] = { type: "noul", noul: "0.5" };
  const outcome = await judgePromotion(fakeClient(okEnvelope(answers)), INPUT, SIGNAL);
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("an answer entry with a NaN noul maps to malformed", async () => {
  const answers = noulAnswers([1, 0.5, 0, 0]);
  answers["is_ephemeral_runtime_noise"] = { type: "noul", noul: Number.NaN };
  const outcome = await judgePromotion(fakeClient(okEnvelope(answers)), INPUT, SIGNAL);
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("an answer entry with a noul below 0 maps to malformed", async () => {
  const answers = noulAnswers([1, 0.5, 0, 0]);
  answers["is_ephemeral_runtime_noise"] = { type: "noul", noul: -0.01 };
  const outcome = await judgePromotion(fakeClient(okEnvelope(answers)), INPUT, SIGNAL);
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("nouls of exactly 0 and 1 are accepted into an ok judgement", async () => {
  const outcome = await judgePromotion(
    fakeClient(okEnvelope(noulAnswers([1, 0, 0, 1]))),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({
    ok: true,
    judgement: {
      model: PROMOTION_PINNED_MODEL_ID,
      answers: answersRecord([1, 0, 0, 1]),
      pPromote: 0,
      shadowPromote: false,
      usage: { inputTokens: 312, outputTokens: 48 },
      usd: promotionUsdForInputTokens(312),
    },
  });
});

test("a foreign answer id is dropped from the judgement answers", async () => {
  const answers = noulAnswers([1, 0.5, 0, 0]);
  answers["is_spam"] = { type: "noul", noul: 0.9 };
  const outcome = await judgePromotion(fakeClient(okEnvelope(answers)), INPUT, SIGNAL);
  expect(outcome).toStrictEqual({
    ok: true,
    judgement: {
      model: PROMOTION_PINNED_MODEL_ID,
      answers: answersRecord([1, 0.5, 0, 0]),
      pPromote: 0.5,
      shadowPromote: true,
      usage: { inputTokens: 312, outputTokens: 48 },
      usd: promotionUsdForInputTokens(312),
    },
  });
});

test("a null usage with valid answers maps to malformed", async () => {
  const outcome = await judgePromotion(
    fakeClient(okEnvelope(noulAnswers([1, 0.5, 0, 0]), { usage: null })),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("a non-integer inputTokens maps to malformed", async () => {
  const outcome = await judgePromotion(
    fakeClient(
      okEnvelope(noulAnswers([1, 0.5, 0, 0]), { usage: { inputTokens: 312.5, outputTokens: 48 } }),
    ),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("a negative inputTokens maps to malformed", async () => {
  const outcome = await judgePromotion(
    fakeClient(
      okEnvelope(noulAnswers([1, 0.5, 0, 0]), { usage: { inputTokens: -1, outputTokens: 48 } }),
    ),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("a string inputTokens maps to malformed", async () => {
  const outcome = await judgePromotion(
    fakeClient(
      okEnvelope(noulAnswers([1, 0.5, 0, 0]), { usage: { inputTokens: "312", outputTokens: 48 } }),
    ),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });
});

test("an inputTokens of 0 is accepted with a zero usd", async () => {
  const outcome = await judgePromotion(
    fakeClient(
      okEnvelope(noulAnswers([1, 0.5, 0, 0]), { usage: { inputTokens: 0, outputTokens: 48 } }),
    ),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toMatchObject({
    ok: true,
    judgement: { usage: { inputTokens: 0, outputTokens: 48 }, usd: 0 },
  });
});

test("a non-number outputTokens falls back to 0 in the judgement usage", async () => {
  const outcome = await judgePromotion(
    fakeClient(
      okEnvelope(noulAnswers([1, 0.5, 0, 0]), { usage: { inputTokens: 312, outputTokens: "48" } }),
    ),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({
    ok: true,
    judgement: {
      model: PROMOTION_PINNED_MODEL_ID,
      answers: answersRecord([1, 0.5, 0, 0]),
      pPromote: 0.5,
      shadowPromote: true,
      usage: { inputTokens: 312, outputTokens: 0 },
      usd: promotionUsdForInputTokens(312),
    },
  });
});

test("an absent outputTokens key falls back to 0 in the judgement usage", async () => {
  const outcome = await judgePromotion(
    fakeClient(okEnvelope(noulAnswers([1, 0.5, 0, 0]), { usage: { inputTokens: 312 } })),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({
    ok: true,
    judgement: {
      model: PROMOTION_PINNED_MODEL_ID,
      answers: answersRecord([1, 0.5, 0, 0]),
      pPromote: 0.5,
      shadowPromote: true,
      usage: { inputTokens: 312, outputTokens: 0 },
      usd: promotionUsdForInputTokens(312),
    },
  });
});

test("the model check runs before answer validation", async () => {
  const outcome = await judgePromotion(
    fakeClient(okEnvelope(null, { model: "jev-1.12.0" })),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({
    ok: false,
    reason: "model_mismatch",
    status: null,
    attempts: 1,
  });
});

test("attempts pass through on a malformed outcome", async () => {
  const answers = noulAnswers([1, 0.5, 0, 0]);
  answers["is_ephemeral_runtime_noise"] = { type: "noul", noul: -0.01 };
  const outcome = await judgePromotion(
    fakeClient(okEnvelope(answers, { attempts: 3 })),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toStrictEqual({ ok: false, reason: "malformed", status: null, attempts: 3 });
});

test("is_ephemeral_runtime_noise alone gates durability", () => {
  expect(derivePromoteProbability(answersRecord([1, 0.75, 0, 0]))).toBeCloseTo(0.25, 12);
});

test("is_prompt_or_task_artifact alone gates durability", () => {
  expect(derivePromoteProbability(answersRecord([1, 0, 0.75, 0]))).toBeCloseTo(0.25, 12);
});

test("is_mechanically_discoverable_from_the_repo alone gates durability", () => {
  expect(derivePromoteProbability(answersRecord([1, 0, 0, 0.75]))).toBeCloseTo(0.25, 12);
});

test("the filters combine by max, not sum or product", () => {
  expect(derivePromoteProbability(answersRecord([1, 0.25, 0.25, 0.25]))).toBeCloseTo(0.75, 12);
});
