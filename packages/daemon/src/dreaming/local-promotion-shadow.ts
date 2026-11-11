import type { TypesafeClient } from "@penumbra/typesafe";

import { createHash } from "node:crypto";

import type { JudgeVote } from "./judge-pool.js";
import type { TypesafeShadowSeat } from "./typesafe-judge-seat.js";

export interface LocalPromotionShadowDecision {
  mode: "shadow";
  applied: false;
  subjectId: string;
  inputSha256: string;
  revision: string;
  model: string | null;
  probability: number | null;
  threshold: number;
  answers: Record<string, number> | null;
  candidatePromote: boolean | null;
  incumbentVotes: JudgeVote[] | null;
  latencyMs: number;
  failure: string | null;
}

function readProbability(answer: { noul: number } | null): number | null {
  if (answer === null) return null;
  return Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
}

export function createLocalPromotionShadowSeat(options: {
  client: TypesafeClient;
  revision: string;
  threshold?: number;
  budgetMs?: number;
  writeDecision: (row: LocalPromotionShadowDecision) => void;
}): TypesafeShadowSeat {
  const threshold = options.threshold ?? 0.5;
  const budgetMs = options.budgetMs ?? 5000;
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1 ||
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < 1 ||
    !options.revision.trim()
  )
    throw new RangeError("invalid local shadow settings");
  return {
    async shadow(args, incumbent): Promise<void> {
      const started = performance.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const { LOCAL_PROMOTION_QUESTIONS } = await import("@penumbra/typesafe");
        const result = await Promise.race([
          options.client.evaluate({
            state: { kind: args.kind, body: args.body },
            questions: { promote: LOCAL_PROMOTION_QUESTIONS.promote },
            signal: controller.signal,
          }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve(null);
            }, budgetMs);
          }),
        ]);
        const answer = result?.ok ? result.answers.promote : null;
        const probability = readProbability(answer);
        const latencyMs = performance.now() - started;
        const votes = await incumbent.catch(() => null);
        options.writeDecision({
          mode: "shadow",
          applied: false,
          subjectId: args.subjectId,
          inputSha256: createHash("sha256").update(args.body).digest("hex"),
          revision: options.revision,
          model: result?.ok ? result.model : null,
          probability,
          threshold,
          answers: result?.ok
            ? Object.fromEntries(
                Object.entries(result.answers).map(([id, value]) => [id, value.noul]),
              )
            : null,
          candidatePromote: probability === null ? null : probability >= threshold,
          incumbentVotes: votes?.map((vote) => ({ ...vote })) ?? null,
          latencyMs,
          failure:
            result === null
              ? "timeout"
              : !result.ok
                ? result.kind
                : probability === null
                  ? "invalid_response"
                  : null,
        });
      } catch {
        /* A shadow transport or sink cannot affect incumbent authority. */
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
