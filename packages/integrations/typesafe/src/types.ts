import { z } from "zod";

/** Path of the TypeSafe evaluation endpoint, appended to the configured base URL. */
export const TYPESAFE_SYSTEMONE_PATH = "/v1/systemone";

export type TypesafeState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion<O extends string = string> {
  type: "choice";
  instructions: string;
  criteria: Readonly<Record<O, string | null>>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: readonly string[];
}

export type TypesafeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer<O extends string = string> {
  type: "choice";
  choice: O;
  probabilities: Readonly<Partial<Record<O, number>>>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Readonly<Record<string, string>>;
  probabilities: Readonly<Record<string, number>>;
  confidence: number;
}

export type AnswerOf<Q extends TypesafeQuestion> = Q extends { type: "noul" }
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends { type: "score" }
      ? ScoreAnswer
      : never;

export type AnswersOf<M extends Record<string, TypesafeQuestion>> = {
  [K in keyof M]: AnswerOf<M[K]>;
};

export type TypesafeFailureKind =
  | "disabled"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "transport"
  | "invalid_request"
  | "invalid_response"
  | "server";

export type TypesafeResult<A> =
  | {
      ok: true;
      model: string;
      answers: A;
      usage: { inputTokens: number; outputTokens: number };
      attempts: number;
    }
  | { ok: false; kind: TypesafeFailureKind; status: number | null; attempts: number };

const NoulWireAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number(),
});

const ChoiceWireAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

const ScoreWireAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

export const SystemOneWireAnswerSchema = z.discriminatedUnion("type", [
  NoulWireAnswerSchema,
  ChoiceWireAnswerSchema,
  ScoreWireAnswerSchema,
]);

export const SystemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), SystemOneWireAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
  }),
});

export type SystemOneWireAnswer = z.infer<typeof SystemOneWireAnswerSchema>;
export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;
