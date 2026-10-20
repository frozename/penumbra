import { expect, test } from "bun:test";

import {
  buildRubricPrompt,
  matchRubricGrade,
  normalizeRubricCriterion,
  rubricFailureOutput,
  RubricResultSchema,
  rubricVerdict,
  runRubricGrade,
} from "./rubric.js";
import {
  DEFAULT_INSPECT_SHA,
  stageTestCtx,
  type WorktreeInspectionResult,
} from "./stage-test-helpers.js";

function jsonBlock(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

// ---------------------------------------------------------------------------
// normalizeRubricCriterion
// ---------------------------------------------------------------------------

test("normalizeRubricCriterion strips leading number and dot", () => {
  expect(normalizeRubricCriterion("1. Fix the bug")).toBe("fix the bug");
});

test("normalizeRubricCriterion strips leading number and paren", () => {
  expect(normalizeRubricCriterion("1) Fix the bug")).toBe("fix the bug");
});

test("normalizeRubricCriterion lowercases and collapses whitespace", () => {
  expect(normalizeRubricCriterion("  Fix   The   BUG  ")).toBe("fix the bug");
});

test("normalizeRubricCriterion strips trailing period", () => {
  expect(normalizeRubricCriterion("Fix the bug.")).toBe("fix the bug");
});

// ---------------------------------------------------------------------------
// matchRubricGrade
// ---------------------------------------------------------------------------

test("matchRubricGrade matches by explicit index", () => {
  const rubric = ["criterion one", "criterion two"];
  const grade = {
    criteria: [
      { index: 1, criterion: "criterion one", pass: true, evidence: "ok" },
      { index: 2, criterion: "criterion two", pass: true, evidence: "ok" },
    ],
  };
  const { results, missing } = matchRubricGrade(rubric, grade);
  expect(missing).toEqual([]);
  expect(results.every((r) => r.pass)).toBe(true);
});

test("matchRubricGrade reports missing criteria", () => {
  const rubric = ["criterion one", "criterion two"];
  const grade = {
    criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
  };
  const { results, missing } = matchRubricGrade(rubric, grade);
  expect(missing).toEqual(["criterion two"]);
  expect(results[1]?.pass).toBe(false);
});

test("matchRubricGrade fuzzy matches by normalized criterion text", () => {
  const rubric = ["Fix the bug"];
  const grade = {
    criteria: [{ index: 0, criterion: "1. fix the bug.", pass: true, evidence: "ok" }],
  };
  const { results, missing } = matchRubricGrade(rubric, grade);
  expect(missing).toEqual([]);
  expect(results[0]?.pass).toBe(true);
});

test("matchRubricGrade containment matches when unique", () => {
  const rubric = ["Fix the bug in the parser"];
  const grade = {
    criteria: [{ index: 0, criterion: "fix the bug", pass: true, evidence: "ok" }],
  };
  const { missing } = matchRubricGrade(rubric, grade);
  expect(missing).toEqual([]);
});

test("matchRubricGrade does not containment match when ambiguous", () => {
  const rubric = ["Fix the bug", "Fix the bug in parser"];
  const grade = {
    criteria: [{ index: 0, criterion: "fix the bug", pass: true, evidence: "ok" }],
  };
  const { missing } = matchRubricGrade(rubric, grade);
  expect(missing.length).toBe(1);
});

test("matchRubricGrade all items must pass for criterion to pass", () => {
  const rubric = ["criterion one"];
  const grade = {
    criteria: [
      { index: 1, criterion: "criterion one", pass: true, evidence: "ok" },
      { index: 1, criterion: "criterion one", pass: false, evidence: "no" },
    ],
  };
  const { results } = matchRubricGrade(rubric, grade);
  expect(results[0]?.pass).toBe(false);
});

test("matchRubricGrade reports duplicate and unknown criteria instead of discarding them", () => {
  const rubric = ["criterion one", "criterion two"];
  const grade = {
    overall_pass: true,
    criteria: [
      { index: 1, criterion: "criterion one", pass: true, evidence: "ok" },
      { index: 1, criterion: "criterion one", pass: true, evidence: "duplicate" },
      { index: 2, criterion: "invented criterion", pass: true, evidence: "unknown" },
    ],
  };
  const matched = matchRubricGrade(rubric, grade);
  expect(matched.duplicates).toEqual(["criterion one"]);
  expect(matched.unknown).toEqual(["invented criterion"]);
  expect(matched.missing).toEqual(["criterion two"]);
});

// ---------------------------------------------------------------------------
// rubricVerdict
// ---------------------------------------------------------------------------

test("rubricVerdict requires criteria even when overall_pass is true", () => {
  expect(rubricVerdict({ overall_pass: true, criteria: [] })).toBe(false);
  expect(rubricVerdict({ overall_pass: false, criteria: [] })).toBe(false);
});

test("rubricVerdict requires explicit overall_pass and every item passing", () => {
  expect(
    rubricVerdict({
      overall_pass: true,
      criteria: [
        { index: 1, criterion: "a", pass: true, evidence: "" },
        { index: 2, criterion: "b", pass: true, evidence: "" },
      ],
    }),
  ).toBe(true);
  expect(
    rubricVerdict({
      overall_pass: true,
      criteria: [
        { index: 1, criterion: "a", pass: true, evidence: "" },
        { index: 2, criterion: "b", pass: false, evidence: "" },
      ],
    }),
  ).toBe(false);
});

test("rubricVerdict returns false for empty criteria without overall_pass", () => {
  expect(rubricVerdict({ criteria: [] })).toBe(false);
  expect(rubricVerdict(null)).toBe(false);
});

// ---------------------------------------------------------------------------
// rubricFailureOutput
// ---------------------------------------------------------------------------

test("rubricFailureOutput returns empty string when verdict passes", () => {
  expect(
    rubricFailureOutput(["a"], {
      overall_pass: true,
      criteria: [{ index: 1, criterion: "a", pass: true, evidence: "ok" }],
    }),
  ).toBe("");
});

test("rubricFailureOutput lists failed and missing criteria", () => {
  const output = rubricFailureOutput(["criterion one", "criterion two"], {
    criteria: [{ index: 1, criterion: "criterion one", pass: false, evidence: "bad" }],
  });
  expect(output).toContain("criterion one");
  expect(output).toContain("bad");
  expect(output).toContain("criterion two");
  expect(output).toContain("grader did not return");
});

// ---------------------------------------------------------------------------
// buildRubricPrompt
// ---------------------------------------------------------------------------

test("buildRubricPrompt includes rubric criteria and candidate info", () => {
  const prompt = buildRubricPrompt({
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one", "criterion two"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
  });
  expect(prompt).toContain("criterion one");
  expect(prompt).toContain("criterion two");
  expect(prompt).toContain("feature/candidate");
  expect(prompt).toContain("handoff-1");
  expect(prompt).toContain("bun run typecheck");
});

// ---------------------------------------------------------------------------
// runRubricGrade
// ---------------------------------------------------------------------------

function ctxWithGrader(
  responseText: string | null,
  dispatchThrows = false,
  awaitThrows = false,
): ReturnType<typeof stageTestCtx>["ctx"] {
  return stageTestCtx(responseText, {
    chainStartThrows: dispatchThrows,
    awaitThrows,
  }).ctx;
}

test("runRubricGrade uses trusted fanout with exact candidate worktree settings", async () => {
  const fixture = stageTestCtx(
    jsonBlock({
      overall_pass: true,
      criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
    }),
  );
  await runRubricGrade(fixture.ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader-agent",
    timeoutMs: 60000,
  });
  expect(fixture.starts).toHaveLength(1);
  expect(fixture.starts[0]).toMatchObject({
    initial_agent: "grader-agent",
    task_type: "review_adversarial",
    use_worktree: true,
    branch_base: DEFAULT_INSPECT_SHA,
    project_id: "penumbra",
    isolated_install: true,
    max_hops: 1,
    tool_free: false,
  });
  expect(fixture.timeouts).toEqual([60000]);
});

test("runRubricGrade returns passed when all criteria pass and overall_pass true", async () => {
  const ctx = ctxWithGrader(
    jsonBlock({
      overall_pass: true,
      criteria: [
        { index: 1, criterion: "criterion one", pass: true, evidence: "ok" },
        { index: 2, criterion: "criterion two", pass: true, evidence: "ok" },
      ],
    }),
  );
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one", "criterion two"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("passed");
  expect(outcome.fail_output).toBe("");
});

test("runRubricGrade rejects a valid root grade for a trustworthy latest child", async () => {
  const mismatched = stageTestCtx(
    jsonBlock({
      overall_pass: true,
      criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
    }),
    { rootReliability: "bad", latestReliability: "good" },
  );
  const mismatchedOutcome = await runRubricGrade(mismatched.ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
    projectId: "penumbra",
  });
  expect(mismatchedOutcome.status).toBe("unavailable");
  expect(mismatchedOutcome.grader_handoff_id).toBe("stage-latest");
  expect(mismatchedOutcome.fail_output).toContain("response identity");
});

test("runRubricGrade rejects untrustworthy latest-hop reliability", async () => {
  const rejected = stageTestCtx(
    jsonBlock({
      overall_pass: true,
      criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
    }),
    { rootReliability: "good", latestReliability: "bad" },
  );
  const rejectedOutcome = await runRubricGrade(rejected.ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
    projectId: "penumbra",
  });
  expect(rejectedOutcome.status).toBe("unavailable");
  expect(rejectedOutcome.fail_output).toContain("latest");
});

test("runRubricGrade fails closed on malformed and truncated candidate inspections", async () => {
  const mutations: ((inspection: WorktreeInspectionResult) => unknown)[] = [
    () => ({}),
    (inspection) => {
      inspection.truncation.total = true;
      return inspection;
    },
  ];
  for (const mutate of mutations) {
    const fixture = stageTestCtx(
      jsonBlock({
        overall_pass: true,
        criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
      }),
    );
    const originalInspect = fixture.ctx.worktreeInspect;
    fixture.ctx.worktreeInspect = async (handoffId) => {
      const inspection = await originalInspect?.(handoffId);
      if (!inspection) return null;
      return handoffId === "handoff-1"
        ? (mutate(inspection) as WorktreeInspectionResult)
        : inspection;
    };
    const outcome = await runRubricGrade(fixture.ctx, {
      taskMessage: "fix the bug",
      taskTitle: "Bug fix",
      check: "bun run typecheck",
      rubric: ["criterion one"],
      candidateBranch: "feature/candidate",
      candidateHandoffId: "handoff-1",
      graderAgent: "grader",
      timeoutMs: 60000,
      projectId: "penumbra",
    }).catch((error: unknown) => ({ status: "threw", fail_output: String(error) }));
    expect(outcome.status).toBe("unavailable");
    expect(outcome.fail_output).toContain("inspection");
    expect(fixture.starts).toEqual([]);
  }
});

test("runRubricGrade binds persisted branch_base to the host SHA", async () => {
  const fixture = stageTestCtx(
    jsonBlock({
      overall_pass: true,
      criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
    }),
    { persistedBranchBase: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  );
  const outcome = await runRubricGrade(fixture.ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
    projectId: "penumbra",
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("branch_base");
});

test("runRubricGrade returns failed when a criterion fails", async () => {
  const ctx = ctxWithGrader(
    jsonBlock({
      overall_pass: false,
      criteria: [
        { index: 1, criterion: "criterion one", pass: true, evidence: "ok" },
        { index: 2, criterion: "criterion two", pass: false, evidence: "bad" },
      ],
    }),
  );
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one", "criterion two"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("criterion two");
});

test("runRubricGrade returns failed when criteria are missing", async () => {
  const ctx = ctxWithGrader(
    jsonBlock({
      overall_pass: true,
      criteria: [{ index: 1, criterion: "criterion one", pass: true, evidence: "ok" }],
    }),
  );
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one", "criterion two"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("criterion two");
  expect(outcome.fail_output).toContain("grader did not return");
});

test("runRubricGrade rejects duplicate criterion coverage", async () => {
  const ctx = ctxWithGrader(
    jsonBlock({
      overall_pass: true,
      criteria: [
        { index: 1, criterion: "criterion one", pass: true, evidence: "ok" },
        { index: 1, criterion: "criterion one", pass: true, evidence: "duplicate" },
        { index: 2, criterion: "criterion two", pass: true, evidence: "ok" },
      ],
    }),
  );
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one", "criterion two"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("duplicate");
});

test("runRubricGrade rejects an unknown criterion even when its index is valid", async () => {
  const ctx = ctxWithGrader(
    jsonBlock({
      overall_pass: true,
      criteria: [
        { index: 1, criterion: "criterion one", pass: true, evidence: "ok" },
        { index: 2, criterion: "invented criterion", pass: true, evidence: "unknown" },
      ],
    }),
  );
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one", "criterion two"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("failed");
  expect(outcome.fail_output).toContain("unknown");
});

test("runRubricGrade returns unavailable (fail-closed) when dispatch throws", async () => {
  const ctx = ctxWithGrader(null, true);
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.grader_handoff_id).toBeNull();
});

test("runRubricGrade returns unavailable when response is unparseable", async () => {
  const ctx = ctxWithGrader("not json");
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.fail_output).toContain("untrusted");
});

test("runRubricGrade returns unavailable when response is empty", async () => {
  const ctx = ctxWithGrader("");
  const outcome = await runRubricGrade(ctx, {
    taskMessage: "fix the bug",
    taskTitle: "Bug fix",
    check: "bun run typecheck",
    rubric: ["criterion one"],
    candidateBranch: "feature/candidate",
    candidateHandoffId: "handoff-1",
    graderAgent: "grader",
    timeoutMs: 60000,
  });
  expect(outcome.status).toBe("unavailable");
});

// ---------------------------------------------------------------------------
// RubricResultSchema
// ---------------------------------------------------------------------------

test("RubricResultSchema accepts a valid grade with overall_pass", () => {
  const parsed = RubricResultSchema.safeParse({
    overall_pass: true,
    criteria: [{ index: 1, criterion: "a", pass: true, evidence: "ok" }],
  });
  expect(parsed.success).toBe(true);
});

test("RubricResultSchema rejects a grade without overall_pass", () => {
  const parsed = RubricResultSchema.safeParse({
    criteria: [{ index: 1, criterion: "a", pass: true, evidence: "ok" }],
  });
  expect(parsed.success).toBe(false);
});

test("RubricResultSchema rejects unknown keys", () => {
  const parsed = RubricResultSchema.safeParse({
    criteria: [],
    extra: true,
  });
  expect(parsed.success).toBe(false);
});
