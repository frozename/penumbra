import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { PromotionAnswers, PromotionClient } from "../src/questions/promotion.js";

import {
  buildPromotionRequest,
  buildPromotionState,
  derivePromoteProbability,
  judgePromotion,
  PROMOTION_PINNED_MODEL_ID,
  PROMOTION_QUESTION_IDS,
  PROMOTION_QUESTIONS,
  PROMOTION_SHADOW_PROMOTE_THRESHOLD,
  promotionUsdForInputTokens,
  UNTRUSTED_BODY_CRITERIA_NOTE,
  UNTRUSTED_BODY_NOTICE,
} from "../src/questions/promotion.js";

const BODY =
  "The reconciler baseline worktree has no node_modules, so `tests: fail` was a false land-gate block.";
const INPUT = { kind: "promote_t1", body: BODY };
const SIGNAL = new AbortController().signal;

type NoulVector = [number, number, number, number];

function answersRecord(nouls: NoulVector): PromotionAnswers {
  return {
    is_durable_fact_worth_keeping: nouls[0],
    is_ephemeral_runtime_noise: nouls[1],
    is_prompt_or_task_artifact: nouls[2],
    is_mechanically_discoverable_from_the_repo: nouls[3],
  };
}

function noulAnswers(nouls: NoulVector): Record<string, { type: "noul"; noul: number }> {
  const answers: Record<string, { type: "noul"; noul: number }> = {};
  for (const [index, id] of PROMOTION_QUESTION_IDS.entries()) {
    answers[id] = { type: "noul", noul: nouls[index] ?? 0 };
  }
  return answers;
}

function okEnvelope(
  answers: Record<string, unknown>,
  options?: {
    model?: string;
    usage?: { inputTokens: number; outputTokens: number };
    attempts?: number;
  },
): unknown {
  return {
    ok: true,
    model: options?.model ?? PROMOTION_PINNED_MODEL_ID,
    answers,
    usage: options?.usage ?? { inputTokens: 312, outputTokens: 48 },
    attempts: options?.attempts ?? 1,
  };
}

function fakeClient(envelope: unknown, captured?: unknown[]): PromotionClient {
  return {
    evaluate: (req: unknown): Promise<unknown> => {
      captured?.push(req);
      return Promise.resolve(envelope);
    },
  } as unknown as PromotionClient;
}

test("promotion questions cover exactly the pinned ids and are all noul", () => {
  expect(Object.keys(PROMOTION_QUESTIONS).sort()).toEqual([...PROMOTION_QUESTION_IDS].sort());
  for (const question of Object.values(PROMOTION_QUESTIONS)) {
    expect(question.type).toBe("noul");
  }
});

test("every question carries the untrusted-body notice and criteria note", () => {
  for (const id of PROMOTION_QUESTION_IDS) {
    const question = PROMOTION_QUESTIONS[id];
    expect(question.instructions).toContain(UNTRUSTED_BODY_NOTICE);
    expect(question.criteria?.true).toContain(UNTRUSTED_BODY_CRITERIA_NOTE);
    expect(question.criteria?.false).toContain(UNTRUSTED_BODY_CRITERIA_NOTE);
  }
});

test("buildPromotionState copies only kind and body", () => {
  const input = { kind: "promote_t1", body: BODY, subjectId: "r1", project_id: "p" };
  expect(buildPromotionState(input)).toEqual({ kind: "promote_t1", body: BODY });
});

test("the pinned model is a versioned id and the request carries no model", () => {
  expect(PROMOTION_PINNED_MODEL_ID).toMatch(/^jev-\d+\.\d+\.\d+$/);
  const input = { kind: "promote_t1", body: BODY };
  expect(Object.keys(buildPromotionRequest(input)).sort()).toEqual(["questions", "state"]);
});

test("derivePromoteProbability gates durability behind the strongest filter", () => {
  expect(derivePromoteProbability(answersRecord([0.9, 0.1, 0.2, 0.05]))).toBeCloseTo(0.72, 12);
  expect(derivePromoteProbability(answersRecord([0.95, 0, 0.9, 0]))).toBeCloseTo(0.095, 12);
});

test("the shadow promote threshold is inclusive", async () => {
  expect(PROMOTION_SHADOW_PROMOTE_THRESHOLD).toBe(0.5);
  const promote = await judgePromotion(
    fakeClient(okEnvelope(noulAnswers([0.5, 0, 0, 0]))),
    INPUT,
    SIGNAL,
  );
  const hold = await judgePromotion(
    fakeClient(okEnvelope(noulAnswers([0.4, 0, 0, 0]))),
    INPUT,
    SIGNAL,
  );
  expect(promote.ok).toBe(true);
  expect(hold.ok).toBe(true);
  if (!promote.ok || !hold.ok) {
    return;
  }
  expect(promote.judgement.pPromote).toBeCloseTo(0.5, 12);
  expect(promote.judgement.shadowPromote).toBe(true);
  expect(hold.judgement.shadowPromote).toBe(false);
});

test("judgePromotion never rejects and maps failure envelopes", async () => {
  const invalidResponse = await judgePromotion(
    fakeClient({ ok: false, kind: "invalid_response", status: 200, attempts: 1 }),
    INPUT,
    SIGNAL,
  );
  expect(invalidResponse).toEqual({
    ok: false,
    reason: "invalid_response",
    status: 200,
    attempts: 1,
  });

  const timeout = await judgePromotion(
    fakeClient({ ok: false, kind: "timeout", status: null, attempts: 1 }),
    INPUT,
    SIGNAL,
  );
  expect(timeout).toEqual({ ok: false, reason: "timeout", status: null, attempts: 1 });

  const outOfRange = await judgePromotion(
    fakeClient(okEnvelope(noulAnswers([0.9, 1.2, 0.2, 0.05]))),
    INPUT,
    SIGNAL,
  );
  expect(outOfRange).toEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });

  const partialAnswers: Record<string, unknown> = {};
  for (const id of PROMOTION_QUESTION_IDS) {
    if (id !== "is_prompt_or_task_artifact") {
      partialAnswers[id] = { type: "noul", noul: 0.5 };
    }
  }
  const missingId = await judgePromotion(fakeClient(okEnvelope(partialAnswers)), INPUT, SIGNAL);
  expect(missingId).toEqual({ ok: false, reason: "malformed", status: null, attempts: 1 });

  const rejecting = {
    evaluate: (): Promise<unknown> => Promise.reject(new Error("scripted rejection")),
  } as unknown as PromotionClient;
  const rejected = await judgePromotion(rejecting, INPUT, SIGNAL);
  expect(rejected).toEqual({ ok: false, reason: "transport", status: null, attempts: 0 });
});

test("a served model other than the pinned id maps to model_mismatch", async () => {
  const outcome = await judgePromotion(
    fakeClient(okEnvelope(noulAnswers([0.9, 0.1, 0.2, 0.05]), { model: "jev-latest" })),
    INPUT,
    SIGNAL,
  );
  expect(outcome).toEqual({ ok: false, reason: "model_mismatch", status: null, attempts: 1 });
});

test("usd derives from input tokens and evaluate receives only state, questions and signal", async () => {
  expect(promotionUsdForInputTokens(1_000_000)).toBe(0.042);
  expect(promotionUsdForInputTokens(312)).toBeCloseTo(0.000013104, 12);

  const captured: unknown[] = [];
  const outcome = await judgePromotion(
    fakeClient(
      okEnvelope(noulAnswers([0.9, 0.1, 0.2, 0.05]), {
        usage: { inputTokens: 312, outputTokens: 48 },
      }),
      captured,
    ),
    INPUT,
    SIGNAL,
  );
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    return;
  }
  expect(outcome.judgement.model).toBe(PROMOTION_PINNED_MODEL_ID);
  expect(outcome.judgement.answers).toEqual(answersRecord([0.9, 0.1, 0.2, 0.05]));
  expect(outcome.judgement.pPromote).toBeCloseTo(0.72, 12);
  expect(outcome.judgement.shadowPromote).toBe(true);
  expect(outcome.judgement.usage).toEqual({ inputTokens: 312, outputTokens: 48 });
  expect(outcome.judgement.usd).toBe(promotionUsdForInputTokens(312));

  expect(captured).toHaveLength(1);
  const request = captured[0] as Record<string, unknown>;
  expect(Object.keys(request).sort()).toEqual(["questions", "signal", "state"]);
  expect(request["state"]).toEqual({ kind: "promote_t1", body: BODY });
  expect(request["questions"]).toBe(PROMOTION_QUESTIONS);
});

test("the package never depends on @penumbra/daemon", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    expect(Object.keys(manifest[field] ?? {})).not.toContain("@penumbra/daemon");
  }
});
