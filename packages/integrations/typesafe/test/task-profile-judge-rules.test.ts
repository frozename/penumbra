import {
  profileTaskDeterministic,
  RoutingTaskTypeSchema,
  type TaskProfileJudge,
  TaskProfileSchema,
} from "@penumbra/core";
import { expect, test } from "bun:test";

import type { TypesafeClient } from "../src/client.js";
import type { TypesafeFailureKind, TypesafeResult } from "../src/types.js";

import { createJevTaskProfileJudge } from "../src/task-profile.js";

type AnswerValue = Record<string, unknown>;
type Answers = Record<string, AnswerValue>;

interface CapturedRequest {
  state: { task_message: string; dispatch_role: string | null };
  questions: Record<string, unknown>;
  signal: AbortSignal;
}

const DEFAULT_CONFIDENCE = 0.9;
const JUDGE_ROLE = "executor";

function stubClient(
  result: TypesafeResult<Answers>,
  calls: CapturedRequest[],
): Pick<TypesafeClient, "evaluate"> {
  return {
    evaluate: ((req: CapturedRequest) => {
      calls.push(req);
      return Promise.resolve(result);
    }) as TypesafeClient["evaluate"],
  };
}

function okResult(model: string, answers: Answers): TypesafeResult<Answers> {
  return {
    ok: true,
    model,
    answers,
    usage: { inputTokens: 1, outputTokens: 0 },
    attempts: 1,
  };
}

function choiceAnswer(choice: string, confidence: number): AnswerValue {
  return { type: "choice", choice, probabilities: {}, confidence };
}

function scoreAnswer(score: number, confidence: number): AnswerValue {
  return { type: "score", score, legend: {}, probabilities: {}, confidence };
}

function fullAnswers(overrides: Record<string, AnswerValue> = {}): Answers {
  return {
    primary_task_type: choiceAnswer("coding", DEFAULT_CONFIDENCE),
    codingDemand: scoreAnswer(2, DEFAULT_CONFIDENCE),
    reasoningDemand: scoreAnswer(2, DEFAULT_CONFIDENCE),
    agenticDemand: scoreAnswer(2, DEFAULT_CONFIDENCE),
    ...overrides,
  };
}

function makeJudge(
  client: Pick<TypesafeClient, "evaluate">,
  options: {
    confidenceFloor?: number;
    deterministicFallback?: typeof profileTaskDeterministic;
  } = {},
): TaskProfileJudge {
  return createJevTaskProfileJudge({
    client,
    confidenceFloor: options.confidenceFloor ?? 0.6,
    ...(options.deterministicFallback === undefined
      ? {}
      : { deterministicFallback: options.deterministicFallback }),
  });
}

test("the constructor rejects a confidenceFloor outside [0, 1] with RangeError", () => {
  const invalidFloors = [Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY] as const;
  for (const confidenceFloor of invalidFloors) {
    expect(() =>
      makeJudge(stubClient(okResult("jev-stub", fullAnswers()), []), { confidenceFloor }),
    ).toThrow(RangeError);
  }
});

test("the constructor accepts the boundary confidenceFloors 0 and 1", () => {
  expect(() =>
    makeJudge(stubClient(okResult("jev-stub", fullAnswers()), []), { confidenceFloor: 0 }),
  ).not.toThrow();
  expect(() =>
    makeJudge(stubClient(okResult("jev-stub", fullAnswers()), []), { confidenceFloor: 1 }),
  ).not.toThrow();
});

const FAILURE_KIND_TO_FALLBACK_REASON: readonly (readonly [
  TypesafeFailureKind,
  "timeout" | "schema_validation_failed" | "judge_error",
])[] = [
  ["timeout", "timeout"],
  ["invalid_response", "schema_validation_failed"],
  ["disabled", "judge_error"],
  ["auth", "judge_error"],
  ["rate_limited", "judge_error"],
  ["transport", "judge_error"],
  ["invalid_request", "judge_error"],
  ["server", "judge_error"],
];

test("every client failure kind maps to its fallback reason and the deterministic profile", async () => {
  const message = "Fix the failing parser regression in the router.";
  const hints = { taskClass: "STANDARD" };
  for (const entry of FAILURE_KIND_TO_FALLBACK_REASON) {
    const kind = entry[0];
    const expectedReason = entry[1];
    const calls: CapturedRequest[] = [];
    const judge = makeJudge(stubClient({ ok: false, kind, status: null, attempts: 1 }, calls));

    const result = await judge.profileTask(message, JUDGE_ROLE, hints);

    expect(result.source).toBe("deterministic");
    if (result.source === "deterministic") {
      expect(result.fallbackReason).toBe(expectedReason);
    }
    expect(result.profile).toEqual(profileTaskDeterministic(message, JUDGE_ROLE, hints));
  }
});

test("a score-typed primary_task_type answer falls back with schema_validation_failed", async () => {
  const calls: CapturedRequest[] = [];
  const judge = makeJudge(
    stubClient(
      okResult(
        "jev-stub",
        fullAnswers({
          primary_task_type: {
            type: "score",
            choice: "coding",
            probabilities: {},
            confidence: 0.9,
          },
        }),
      ),
      calls,
    ),
  );

  const result = await judge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);

  expect(result.source).toBe("deterministic");
  if (result.source === "deterministic") {
    expect(result.fallbackReason).toBe("schema_validation_failed");
  }
});

test("a primary choice outside RoutingTaskTypeSchema falls back with schema_validation_failed", async () => {
  const judge = makeJudge(
    stubClient(
      okResult("jev-stub", fullAnswers({ primary_task_type: choiceAnswer("poetry", 0.9) })),
      [],
    ),
  );

  const result = await judge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);

  expect(result.source).toBe("deterministic");
  if (result.source === "deterministic") {
    expect(result.fallbackReason).toBe("schema_validation_failed");
  }
  expect(RoutingTaskTypeSchema.options).not.toContain("poetry");
});

test("an axis confidence above 1 falls back with schema_validation_failed", async () => {
  const judge = makeJudge(
    stubClient(okResult("jev-stub", fullAnswers({ codingDemand: scoreAnswer(2, 1.5) })), []),
  );

  const result = await judge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);

  expect(result.source).toBe("deterministic");
  if (result.source === "deterministic") {
    expect(result.fallbackReason).toBe("schema_validation_failed");
  }
});

test("a negative axis confidence falls back with schema_validation_failed", async () => {
  const judge = makeJudge(
    stubClient(okResult("jev-stub", fullAnswers({ reasoningDemand: scoreAnswer(2, -0.5) })), []),
  );

  const result = await judge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);

  expect(result.source).toBe("deterministic");
  if (result.source === "deterministic") {
    expect(result.fallbackReason).toBe("schema_validation_failed");
  }
});

test("axis scores normalize to the unit interval with two-decimal rounding", async () => {
  const midJudge = makeJudge(
    stubClient(okResult("jev-stub", fullAnswers({ codingDemand: scoreAnswer(2.5, 0.9) })), []),
  );
  const midResult = await midJudge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);
  expect(midResult.source).toBe("jev");
  if (midResult.source === "jev") {
    expect(midResult.profile.codingDemand).toBe(0.63);
    expect(TaskProfileSchema.safeParse(midResult.profile).success).toBe(true);
  }

  const lowJudge = makeJudge(
    stubClient(okResult("jev-stub", fullAnswers({ codingDemand: scoreAnswer(1, 0.9) })), []),
  );
  const lowResult = await lowJudge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);
  expect(lowResult.source).toBe("jev");
  if (lowResult.source === "jev") {
    expect(lowResult.profile.codingDemand).toBe(0.25);
    expect(TaskProfileSchema.safeParse(lowResult.profile).success).toBe(true);
  }
});

const otherTaskTypesFallback = (
  message: string,
  role?: string,
  hints?: Parameters<typeof profileTaskDeterministic>[2],
): ReturnType<typeof profileTaskDeterministic> => ({
  ...profileTaskDeterministic(message, role, hints ?? {}),
  taskTypes: ["other"],
});

test("an accepted jev choice replaces the deterministic other task type", async () => {
  const judge = makeJudge(stubClient(okResult("jev-stub", fullAnswers()), []), {
    deterministicFallback: otherTaskTypesFallback,
  });

  const result = await judge.profileTask("qwerty uiop asdf ghjk zxcv", JUDGE_ROLE);

  expect(result.source).toBe("jev");
  if (result.source === "jev") {
    expect(result.profile.taskTypes).toEqual(["coding"]);
    expect(TaskProfileSchema.safeParse(result.profile).success).toBe(true);
  }
});

test("an accepted other choice keeps the deterministic other task type", async () => {
  const judge = makeJudge(
    stubClient(
      okResult("jev-stub", fullAnswers({ primary_task_type: choiceAnswer("other", 0.9) })),
      [],
    ),
    { deterministicFallback: otherTaskTypesFallback },
  );

  const result = await judge.profileTask("qwerty uiop asdf ghjk zxcv", JUDGE_ROLE);

  expect(result.source).toBe("jev");
  if (result.source === "jev") {
    expect(result.profile.taskTypes).toEqual(["other"]);
    expect(TaskProfileSchema.safeParse(result.profile).success).toBe(true);
  }
});

test("the rationale names the jev model, the accepted axes and the primary choice", async () => {
  const judge = makeJudge(stubClient(okResult("jev-stub-model", fullAnswers()), []));

  const result = await judge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);

  expect(result.source).toBe("jev");
  if (result.source === "jev") {
    expect(result.profile.rationale[0]).toBe(
      "jev jev-stub-model: primary_task_type, codingDemand, reasoningDemand, agenticDemand",
    );
    expect(result.profile.rationale).toContain("primary_task_type=coding");
    expect(result.profile.rationale.join("\n")).not.toContain("state_truncated");
    expect(TaskProfileSchema.safeParse(result.profile).success).toBe(true);
  }
});

test("a below-floor primary choice omits the primary_task_type rationale entry", async () => {
  const judge = makeJudge(
    stubClient(
      okResult("jev-stub-model", fullAnswers({ primary_task_type: choiceAnswer("coding", 0.4) })),
      [],
    ),
  );

  const result = await judge.profileTask("Fix the failing parser regression.", JUDGE_ROLE);

  expect(result.source).toBe("jev");
  if (result.source === "jev") {
    expect(result.profile.rationale.some((line) => line.startsWith("primary_task_type="))).toBe(
      false,
    );
    expect(TaskProfileSchema.safeParse(result.profile).success).toBe(true);
  }
});

test("profileTask without a role records dispatch_role null in the request", async () => {
  const calls: CapturedRequest[] = [];
  const judge = makeJudge(stubClient(okResult("jev-stub", fullAnswers()), calls));

  const result = await judge.profileTask("Fix the failing parser regression.");

  expect(calls).toHaveLength(1);
  expect(calls[0]!.state.task_message).toBe("Fix the failing parser regression.");
  expect(calls[0]!.state.dispatch_role).toBeNull();
  expect(result.source).toBe("jev");
  if (result.source === "jev") {
    expect(TaskProfileSchema.safeParse(result.profile).success).toBe(true);
  }
});

test("an injected deterministicFallback receives the exact arguments and its return value is used on failure", async () => {
  const message = "Fix the failing parser regression.";
  const hints = { taskClass: "STANDARD" };
  const fallbackProfile = profileTaskDeterministic(message, JUDGE_ROLE, hints);
  const captured: Parameters<typeof profileTaskDeterministic>[] = [];
  const judge = makeJudge(
    stubClient({ ok: false, kind: "timeout", status: null, attempts: 1 }, []),
    {
      deterministicFallback: (m, r, h) => {
        captured.push([m, r, h]);
        return fallbackProfile;
      },
    },
  );

  const result = await judge.profileTask(message, JUDGE_ROLE, hints);

  expect(captured).toHaveLength(1);
  expect(captured[0]).toEqual([message, JUDGE_ROLE, hints]);
  expect(result.source).toBe("deterministic");
  if (result.source === "deterministic") {
    expect(result.fallbackReason).toBe("timeout");
  }
  expect(result.profile).toBe(fallbackProfile);
});
