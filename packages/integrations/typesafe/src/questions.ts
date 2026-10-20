import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "./types.js";

export function noul(
  instructions: string,
  criteria?: { true?: string; false?: string },
): NoulQuestion {
  const question: NoulQuestion = { type: "noul", instructions };
  if (criteria !== undefined) {
    question.criteria = { ...criteria };
  }
  return question;
}

export function choice<const O extends string>(
  instructions: string,
  criteria: Readonly<Record<O, string | null>>,
): ChoiceQuestion<O> {
  return { type: "choice", instructions, criteria: { ...criteria } };
}

export function score(
  instructions: string,
  criteria: readonly [string, string, ...string[]],
): ScoreQuestion {
  return { type: "score", instructions, criteria: [...criteria] };
}
