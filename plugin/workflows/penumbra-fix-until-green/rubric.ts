import type { WorkflowCtx } from "@penumbra/workflows";

import { z } from "zod";

import { type FanoutTaskResult, runFanout } from "../_shared/fanout.js";
import {
  parseStructured,
  renderJsonContract,
  type SafeParseSchema,
} from "../_shared/structured.js";
import { type CandidateRef, resolveAuthoritativeCandidate } from "./candidate.js";
import { inspectBoundWorktree, worktreeBindingFailure } from "./worktree-binding.js";

export const RubricResultSchema = z
  .object({
    overall_pass: z.boolean(),
    criteria: z
      .array(
        z
          .object({
            index: z.number().int(),
            criterion: z.string().min(1).max(500),
            pass: z.boolean(),
            evidence: z.string().max(600),
          })
          .strict(),
      )
      .max(20),
    notes: z.string().max(600).optional(),
  })
  .strict();

export type RubricGrade = z.infer<typeof RubricResultSchema>;
type RubricGradeLike = Omit<RubricGrade, "overall_pass"> & { overall_pass?: boolean };

export type RubricCriterionResult = {
  index: number;
  criterion: string;
  pass: boolean;
  evidence: string;
};

export type RubricMatchResult = {
  results: RubricCriterionResult[];
  missing: string[];
  duplicates: string[];
  unknown: string[];
};

export type RubricGradeOutcome = {
  status: "passed" | "failed" | "unavailable";
  grade: RubricGrade | null;
  grader_handoff_id: string | null;
  grader_branch: string | null;
  fail_output: string;
};

const RUBRIC_EXAMPLE = JSON.stringify(
  {
    overall_pass: true,
    criteria: [{ index: 1, criterion: "criterion text", pass: true, evidence: "evidence" }],
    notes: "",
  },
  null,
  2,
);

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeRubricCriterion(value: unknown): string {
  return asString(value)
    .toLowerCase()
    .replaceAll(/^\s*\d+\s*[.):-]\s*/g, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll(/\.$/g, "")
    .trim();
}

function uniqueContainmentMatch(normalizedRubric: string[], criterion: string): number {
  const matches = normalizedRubric.flatMap((candidate, index) =>
    candidate && (candidate.includes(criterion) || criterion.includes(candidate)) ? [index] : [],
  );
  return matches.length === 1 ? (matches[0] ?? -1) : -1;
}

function textMatchIndex(normalizedRubric: string[], criterion: string): number {
  const exact = normalizedRubric.flatMap((candidate, index) =>
    candidate === criterion ? [index] : [],
  );
  if (exact.length === 1) return exact[0] ?? -1;
  return criterion ? uniqueContainmentMatch(normalizedRubric, criterion) : -1;
}

function resolveMatchIndex(
  item: RubricGrade["criteria"][number],
  normalizedRubric: string[],
): number {
  const criterion = normalizeRubricCriterion(item.criterion);
  const textIndex = textMatchIndex(normalizedRubric, criterion);
  if (textIndex < 0) return -1;
  if (item.index < 1 || item.index > normalizedRubric.length) return textIndex;
  return item.index - 1 === textIndex ? textIndex : -1;
}

export function matchRubricGrade(
  rubric: string[],
  grade: RubricGradeLike | null,
): RubricMatchResult {
  const normalizedRubric = rubric.map(normalizeRubricCriterion);
  const buckets: RubricGrade["criteria"][] = rubric.map(() => []);
  const unknown: string[] = [];

  for (const item of grade?.criteria ?? []) {
    const matchIndex = resolveMatchIndex(item, normalizedRubric);
    const bucket = buckets[matchIndex];
    if (matchIndex < 0 || !bucket) {
      unknown.push(item.criterion);
      continue;
    }
    bucket.push(item);
  }

  const missing: string[] = [];
  const duplicates: string[] = [];
  const results = rubric.map((criterion, index): RubricCriterionResult => {
    const items = buckets[index] ?? [];
    if (items.length === 0) missing.push(criterion);
    if (items.length > 1) duplicates.push(criterion);
    return {
      index: index + 1,
      criterion,
      pass: items.length === 1 && items[0]?.pass === true,
      evidence: items
        .map((item) => item.evidence.trim())
        .filter(Boolean)
        .join("; "),
    };
  });
  return { results, missing, duplicates, unknown };
}

export function rubricVerdict(grade: RubricGradeLike | null): boolean {
  return (
    grade?.overall_pass === true && grade.criteria.length > 0 && grade.criteria.every((c) => c.pass)
  );
}

export function rubricFailureOutput(rubric: string[], grade: RubricGradeLike | null): string {
  const matched = matchRubricGrade(rubric, grade);
  if (coverageIsExact(matched) && rubricVerdict(grade) && matched.results.every((c) => c.pass)) {
    return "";
  }
  const lines = ["The check command passed, but independent rubric grading failed:"];
  for (const criterion of matched.missing) {
    lines.push(`- ${criterion}: grader did not return this criterion`);
  }
  for (const criterion of matched.duplicates) lines.push(`- ${criterion}: duplicate criterion`);
  for (const criterion of matched.unknown) lines.push(`- ${criterion}: unknown criterion`);
  for (const item of matched.results) {
    if (
      !item.pass &&
      !matched.missing.includes(item.criterion) &&
      !matched.duplicates.includes(item.criterion)
    ) {
      lines.push(`- ${item.criterion}: ${item.evidence || "(no evidence provided)"}`);
    }
  }
  if (grade?.overall_pass === false) lines.push("- overall_pass was false");
  if (grade?.notes) lines.push(`Grader notes: ${grade.notes}`);
  return lines.join("\n");
}

export function buildRubricPrompt(opts: {
  taskMessage: string;
  taskTitle: string;
  check: string;
  rubric: string[];
  candidateBranch: string;
  candidateHandoffId: string;
}): string {
  return [
    "You are an independent rubric grader in a separate worktree based on the exact candidate branch. Refute unsupported claims. Do not edit, dispatch, land, push, or alter branches.",
    "",
    "Original task:",
    `Title: ${opts.taskTitle}`,
    `Message preview: ${opts.taskMessage.slice(0, 400)}…`,
    "",
    `Candidate branch: ${opts.candidateBranch}`,
    `Handoff id: ${opts.candidateHandoffId}`,
    `Inspect the authoritative candidate with mcp__penumbra__worktree_inspect({ handoff_id: ${JSON.stringify(opts.candidateHandoffId)} }) and inspect the assigned checkout.`,
    "",
    `The worker reported CHECK_RESULT: PASS for: ${opts.check}`,
    opts.rubric.map((criterion, index) => `${String(index + 1)}. ${criterion}`).join("\n"),
    "",
    "Return explicit overall_pass and exactly one passing or failing item for every criterion. Use its listed index and criterion text; duplicates, unknown criteria, and missing criteria fail closed.",
    "",
    renderJsonContract({ example: RUBRIC_EXAMPLE, name: "RUBRIC_RESULT" }),
  ].join("\n");
}

function unavailable(
  failOutput: string,
  handoffId: string | null = null,
  branch: string | null = null,
): RubricGradeOutcome {
  return {
    status: "unavailable",
    grade: null,
    grader_handoff_id: handoffId,
    grader_branch: branch,
    fail_output: failOutput,
  };
}

function coverageIsExact(match: RubricMatchResult): boolean {
  return match.missing.length === 0 && match.duplicates.length === 0 && match.unknown.length === 0;
}

function graderDispatchBindingFailure(
  result: FanoutTaskResult,
  grader: CandidateRef,
  expectedSha: string,
): RubricGradeOutcome | null {
  if (result.root_handoff_id !== grader.handoffId) {
    return unavailable(
      `Independent rubric grader response identity was unsupported: expected ${grader.handoffId}, received ${String(result.root_handoff_id)}.`,
      grader.handoffId,
      grader.branch,
    );
  }
  if (result.branch_base !== expectedSha) {
    return unavailable(
      `Independent rubric grader persisted root branch_base mismatch: expected ${expectedSha}, received ${String(result.branch_base)}.`,
      grader.handoffId,
      grader.branch,
    );
  }
  return null;
}

async function dispatchGrader(
  ctx: WorkflowCtx,
  opts: {
    prompt: string;
    expectedSha: string;
    graderAgent: string;
    timeoutMs: number;
    projectId: string;
  },
): Promise<Awaited<ReturnType<typeof runFanout>> | null> {
  try {
    return await runFanout(ctx, {
      tasks: [
        {
          message: opts.prompt,
          label: "rubric-grade",
          task_name: "rubric-grade",
          initial_agent: opts.graderAgent,
          task_class: "STANDARD",
          task_type: "review_adversarial",
          use_worktree: true,
          branch_base: opts.expectedSha,
          isolated_install: true,
          max_hops: 1,
          tool_free: false,
          timeout_ms: opts.timeoutMs,
        },
      ],
      defaults: { project_id: opts.projectId, timeout_ms: opts.timeoutMs },
    });
  } catch {
    return null;
  }
}

function interpretRubricResponse(
  responseText: string,
  grader: CandidateRef,
  rubric: string[],
): RubricGradeOutcome {
  const parsed = parseStructured(
    responseText,
    RubricResultSchema as unknown as SafeParseSchema<RubricGrade>,
  );
  if (!parsed.ok) {
    const issues = parsed.issues ? ` (${parsed.issues.join("; ")})` : "";
    return unavailable(
      `Independent rubric grader response was untrusted: ${parsed.error}${issues}`,
      grader.handoffId,
      grader.branch,
    );
  }
  const grade = parsed.value;
  const matched = matchRubricGrade(rubric, grade);
  const passed =
    coverageIsExact(matched) && rubricVerdict(grade) && matched.results.every((c) => c.pass);
  return {
    status: passed ? "passed" : "failed",
    grade,
    grader_handoff_id: grader.handoffId,
    grader_branch: grader.branch,
    fail_output: passed ? "" : rubricFailureOutput(rubric, grade),
  };
}

export async function runRubricGrade(
  ctx: WorkflowCtx,
  opts: {
    taskMessage: string;
    taskTitle: string;
    check: string;
    rubric: string[];
    candidateBranch: string;
    candidateHandoffId: string;
    graderAgent: string;
    timeoutMs: number;
    projectId?: string;
  },
): Promise<RubricGradeOutcome> {
  const projectId = opts.projectId ?? ctx.project;
  const preInspect = await inspectBoundWorktree(ctx, {
    handoffId: opts.candidateHandoffId,
    branchName: opts.candidateBranch,
    projectId,
  });
  if (!preInspect.ok) {
    return unavailable(worktreeBindingFailure("Independent rubric candidate pre", preInspect));
  }
  const expectedSha = preInspect.headSha;
  const stage = await dispatchGrader(ctx, {
    prompt: buildRubricPrompt(opts),
    expectedSha,
    graderAgent: opts.graderAgent,
    timeoutMs: opts.timeoutMs,
    projectId,
  });
  const result = stage?.results[0] ?? null;
  const grader = resolveAuthoritativeCandidate(result);
  if (result?.status !== "completed") {
    return unavailable(
      "Independent rubric grader dispatch was unavailable or non-terminal.",
      grader.ok ? grader.candidate.handoffId : (result?.handoff_id ?? null),
      grader.ok ? grader.candidate.branch : (result?.branch_name ?? null),
    );
  }
  if (!grader.ok) {
    return unavailable(
      `Independent rubric grader latest identity was unsupported: ${grader.reason}.`,
    );
  }
  const dispatchBindingFailure = graderDispatchBindingFailure(
    result,
    grader.candidate,
    expectedSha,
  );
  if (dispatchBindingFailure) return dispatchBindingFailure;
  const graderInspect = await inspectBoundWorktree(ctx, {
    handoffId: grader.candidate.handoffId,
    branchName: grader.candidate.branch,
    projectId,
    headSha: expectedSha,
  });
  if (!graderInspect.ok) {
    return unavailable(
      worktreeBindingFailure("Independent rubric grader host", graderInspect),
      grader.candidate.handoffId,
      grader.candidate.branch,
    );
  }
  if (!result.response_text?.trim()) {
    return unavailable(
      "Independent rubric grader returned no response.",
      grader.candidate.handoffId,
      grader.candidate.branch,
    );
  }

  const outcome = interpretRubricResponse(result.response_text, grader.candidate, opts.rubric);
  if (outcome.status !== "passed") return outcome;

  const postInspect = await inspectBoundWorktree(ctx, {
    handoffId: opts.candidateHandoffId,
    branchName: opts.candidateBranch,
    projectId,
    headSha: expectedSha,
  });
  if (!postInspect.ok) {
    return unavailable(
      worktreeBindingFailure("Independent rubric candidate post", postInspect),
      grader.candidate.handoffId,
      grader.candidate.branch,
    );
  }
  return outcome;
}
