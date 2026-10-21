import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { join } from "node:path";
import { z } from "zod";

import type { FanoutHop } from "../_shared/fanout-hop-evidence.js";

import {
  type FanoutDefaults,
  type FanoutTask,
  type FanoutTaskResult,
  runFanout,
} from "../_shared/fanout.js";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";
import { parseStructured, renderJsonContract } from "../_shared/structured.js";

const TaskClassEnum = z.enum(["BOUNDARY", "STANDARD", "TRIVIAL"]);
const TaskTypeEnum = z.enum([
  "plan_refine",
  "implement_small",
  "implement_substantial",
  "review_adversarial",
  "docs_mechanical",
  "debug_diagnose",
  "smoke_test",
  "health_check",
  "unknown",
]);
const TrustModeEnum = z.enum(["all", "config"]);

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TERMINAL_HOP_STATUSES = new Set(["completed", "failed", "rejected", "expired"]);

const taskFields = {
  task_name: z.string().min(1).max(120).optional(),
  branch_type: z.string().min(1).optional(),
  task_class: TaskClassEnum.optional(),
  task_type: TaskTypeEnum.optional(),
  trust_mode: TrustModeEnum.optional(),
  use_worktree: z.boolean().optional(),
  max_hops: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  branch_base: z.string().min(1).optional(),
  response_mode: z.enum(["full", "first_line", "none"]).optional(),
  project_id: z.string().min(1).optional(),
  isolated_install: z.boolean().optional(),
};

const TaskSchema = z
  .object({
    message: z.string().min(1),
    label: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(120).optional(),
    ...taskFields,
  })
  .strict();

const DefaultsSchema = z.object({ ...taskFields }).strict();

export const inputSchema = z
  .object({
    task: TaskSchema,
    agents: z.array(z.string().min(1)).min(1).max(16),
    defaults: DefaultsSchema.optional(),
    project_id: z.string().min(1).optional(),
    caller_cwd: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    out_dir: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const RankingEntrySchema = z
  .object({
    branch: z.string().min(1),
    agent: z.string().min(1),
    score: z.number().min(0).max(10),
    notes: z.string().optional(),
  })
  .strict();

const VerdictSchema = z
  .object({
    winner_branch: z.string().min(1),
    winner_agent: z.string().min(1),
    rationale: z.string().optional(),
    ranking: z.array(RankingEntrySchema).min(1),
  })
  .strict();

type Verdict = z.infer<typeof VerdictSchema>;
type RankingEntry = z.infer<typeof RankingEntrySchema>;

type WorktreeInspection = NonNullable<
  NonNullable<WorkflowCtx["worktreeInspect"]> extends (handoffId: string) => Promise<infer R>
    ? R
    : never
>;

export type CandidateSummary = {
  agent: string;
  branch: string | null;
  handoff_id: string | null;
  root_handoff_id: string | null;
  latest_handoff_id: string | null;
  root_branch_name: string | null;
  ok: boolean;
  reliability_trustworthy: boolean | null;
  reliability_status: string | null;
  latest_reliability_trustworthy: boolean | null;
  latest_reliability_status: string | null;
  error_summary: string | null;
  inspected: boolean;
  inspection_valid: boolean;
  inspection_state: "not_run" | "unavailable" | "valid";
  inspection_error: string | null;
  head_sha: string | null;
  dirty: boolean | null;
  truncated: boolean | null;
};

export type JudgeSummary = {
  handoff_id: string | null;
  conversation_id: string | null;
  ok: boolean;
  reliability_trustworthy: boolean | null;
  response_path: string | null;
  response_chars: number | null;
  error: string | null;
};

export type TournamentResult = {
  ok: boolean;
  error: string | null;
  task_message: string;
  agents: string[];
  candidates: CandidateSummary[];
  qualified_count: number;
  verdict: Verdict | null;
  winner: string | null;
  winner_agent: string | null;
  branches: string[];
  loser_branches: string[];
  judge: JudgeSummary | null;
  reinspection: { head_sha: string; changed: boolean } | null;
};

type QualifiedCandidate = {
  agent: string;
  branch: string;
  handoff_id: string;
  inspection: WorktreeInspection;
};

type LatestCandidate = Omit<QualifiedCandidate, "inspection">;

type InspectionEvidence =
  | { ok: true; inspection: WorktreeInspection }
  | {
      ok: false;
      inspection: null;
      error: string;
      headSha: string | null;
      dirty: boolean | null;
      truncated: boolean | null;
    };

const VERDICT_EXAMPLE = JSON.stringify(
  {
    winner_branch: "feature/candidate-a",
    winner_agent: "codex-acp-deep",
    rationale: "clean diff, correct logic, minimal scope",
    ranking: [
      { branch: "feature/candidate-a", agent: "codex-acp-deep", score: 9, notes: "correct" },
      { branch: "feature/candidate-b", agent: "gemini-acp-pro", score: 6, notes: "works" },
    ],
  },
  null,
  2,
);

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inspectionFailure(
  error: string,
  headSha: string | null,
  dirty: boolean | null,
  truncated: boolean | null,
): InspectionEvidence {
  return { ok: false, inspection: null, error, headSha, dirty, truncated };
}

function hasExpectedInspectionShape(
  inspection: Record<string, unknown>,
  worktree: Record<string, unknown>,
  truncation: Record<string, unknown>,
  headSha: string | null,
  dirty: boolean | null,
): boolean {
  const requiredStrings = [
    worktree.handoffId,
    worktree.path,
    worktree.branchName,
    worktree.storageRoot,
    worktree.createdAt,
    inspection.branch_name,
    headSha,
  ];
  const requiredConditions = [
    worktree.status === "created",
    worktree.worktreeMode === "symlink_mirror" || worktree.worktreeMode === "isolated_install",
    typeof inspection.diff_against_main === "string",
    typeof inspection.branch_log === "string",
    dirty !== null,
    typeof truncation.diff_against_main === "boolean",
    typeof truncation.branch_log === "boolean",
    typeof truncation.total === "boolean",
  ];
  return requiredStrings.every(hasNonEmptyString) && requiredConditions.every(Boolean);
}

function resolveLatestCandidate(result: FanoutTaskResult): LatestCandidate | null {
  if (
    result.hops_incomplete !== false ||
    result.latest_reliability_trustworthy !== true ||
    !hasNonEmptyString(result.latest_handoff_id) ||
    !Array.isArray(result.hops)
  ) {
    return null;
  }
  const matchingHops = result.hops.filter(
    (hop): hop is FanoutHop =>
      hop.handoff_id === result.latest_handoff_id && hop.status === "completed",
  );
  if (matchingHops.length !== 1) return null;
  const [latest] = matchingHops;
  if (
    !latest ||
    !hasNonEmptyString(latest.branch_name) ||
    !hasNonEmptyString(latest.to_agent) ||
    !TERMINAL_HOP_STATUSES.has(latest.status)
  ) {
    return null;
  }
  return {
    handoff_id: latest.handoff_id,
    branch: latest.branch_name,
    agent: latest.to_agent,
  };
}

function resolveTaskName(task: Input["task"], defaults: Input["defaults"]): string | undefined {
  return (
    task.task_name ?? task.label ?? task.name ?? task.title ?? defaults?.task_name ?? undefined
  );
}

function buildCandidateTasks(input: Input): FanoutTask[] {
  const { task, defaults } = input;
  const taskName = resolveTaskName(task, defaults);
  return input.agents.map((agent) => {
    const { label: _l, name: _n, title: _t, ...rest } = task;
    const fanoutTask: FanoutTask = {
      ...rest,
      label: `compete:${agent}`,
      initial_agent: agent,
      use_worktree: true,
    };
    if (taskName !== undefined) fanoutTask.task_name = taskName;
    return fanoutTask;
  });
}

function buildFanoutDefaults(input: Input): FanoutDefaults {
  const result: FanoutDefaults = { ...(input.defaults ?? {}) };
  const projectId = input.task.project_id ?? input.defaults?.project_id ?? input.project_id;
  if (projectId !== undefined) result.project_id = projectId;
  if (input.timeout_ms !== undefined && result.timeout_ms === undefined) {
    result.timeout_ms = input.timeout_ms;
  }
  return result;
}

function scopeIsSupported(input: Input, ctx: WorkflowCtx): boolean {
  const projectIds = [input.project_id, input.defaults?.project_id, input.task.project_id].filter(
    (value): value is string => value !== undefined,
  );
  if (projectIds.some((projectId) => projectId !== ctx.project)) return false;
  const paths = [input.repo, input.caller_cwd].filter(
    (value): value is string => value !== undefined,
  );
  return paths.every((path) => path === ctx.cwd);
}

function validateInspection(
  raw: unknown,
  expected: { handoffId: string; branch: string; project: string },
): InspectionEvidence {
  const inspection = record(raw);
  if (!inspection) return inspectionFailure("inspection_malformed", null, null, null);
  const worktree = record(inspection.worktree);
  const truncation = record(inspection.truncation);
  const headSha = typeof inspection.head_sha === "string" ? inspection.head_sha : null;
  const dirty = typeof inspection.dirty === "boolean" ? inspection.dirty : null;
  const truncated = truncation && typeof truncation.total === "boolean" ? truncation.total : null;
  if (
    !worktree ||
    !truncation ||
    !hasExpectedInspectionShape(inspection, worktree, truncation, headSha, dirty)
  ) {
    return inspectionFailure("inspection_malformed", headSha, dirty, truncated);
  }
  if (
    [worktree.handoffId, inspection.branch_name, worktree.branchName].some(
      (value, index) => value !== [expected.handoffId, expected.branch, expected.branch][index],
    )
  )
    return inspectionFailure("inspection_binding_mismatch", headSha, dirty, truncated);
  if (
    worktree.projectId !== undefined &&
    (!hasNonEmptyString(worktree.projectId) || worktree.projectId !== expected.project)
  ) {
    return inspectionFailure("inspection_project_mismatch", headSha, dirty, truncated);
  }
  if (!hasNonEmptyString(headSha) || !SHA_RE.test(headSha))
    return inspectionFailure("inspection_invalid_head", headSha, dirty, truncated);
  if (dirty) return inspectionFailure("inspection_dirty", headSha, dirty, truncated);
  if ([truncation.diff_against_main, truncation.branch_log, truncation.total].some(Boolean)) {
    return inspectionFailure("inspection_truncated", headSha, dirty, truncated);
  }
  return { ok: true, inspection: raw as WorktreeInspection };
}

function summarizeCandidate(
  result: FanoutTaskResult,
  latest: LatestCandidate | null,
  evidence: InspectionEvidence | null,
): CandidateSummary {
  return {
    agent: latest?.agent ?? result.initial_agent,
    branch: latest?.branch ?? null,
    handoff_id: latest?.handoff_id ?? null,
    root_handoff_id: result.root_handoff_id,
    latest_handoff_id: result.latest_handoff_id,
    root_branch_name: result.branch_name,
    ok: result.ok,
    reliability_trustworthy: result.reliability_trustworthy,
    reliability_status: result.reliability_status,
    latest_reliability_trustworthy: result.latest_reliability_trustworthy,
    latest_reliability_status: result.latest_reliability_status,
    error_summary: result.error_summary,
    inspected: evidence !== null,
    inspection_valid: evidence?.ok ?? false,
    inspection_state: evidence?.ok ? "valid" : evidence ? "unavailable" : "not_run",
    inspection_error: evidence?.ok ? null : (evidence?.error ?? null),
    head_sha: evidence?.ok ? evidence.inspection.head_sha : (evidence?.headSha ?? null),
    dirty: evidence?.ok ? evidence.inspection.dirty : (evidence?.dirty ?? null),
    truncated: evidence?.ok ? evidence.inspection.truncation.total : (evidence?.truncated ?? null),
  };
}

async function inspectAndFilter(
  ctx: WorkflowCtx,
  results: FanoutTaskResult[],
  project: string,
): Promise<{ qualified: QualifiedCandidate[]; summaries: CandidateSummary[] }> {
  const qualified: QualifiedCandidate[] = [];
  const summaries: CandidateSummary[] = [];
  for (const result of results) {
    const latest = resolveLatestCandidate(result);
    if (latest === null || result.status !== "completed") {
      summaries.push(summarizeCandidate(result, latest, null));
      continue;
    }
    let evidence: InspectionEvidence;
    try {
      const raw = await ctx.worktreeInspect?.(latest.handoff_id);
      evidence = validateInspection(raw, {
        handoffId: latest.handoff_id,
        branch: latest.branch,
        project,
      });
    } catch {
      evidence = {
        ok: false,
        inspection: null,
        error: "inspection_unavailable",
        headSha: null,
        dirty: null,
        truncated: null,
      };
    }
    summaries.push(summarizeCandidate(result, latest, evidence));
    if (evidence.ok) {
      qualified.push({
        ...latest,
        inspection: evidence.inspection,
      });
    }
  }
  return { qualified, summaries };
}

function buildJudgePrompt(taskMessage: string, candidates: QualifiedCandidate[]): string {
  const roster = candidates
    .map(
      (c) =>
        `### Candidate: ${c.branch}\nAgent: ${c.agent}\nHead SHA: ${c.inspection.head_sha}\n\n**Branch log:**\n${c.inspection.branch_log}\n\n**Diff against ${c.inspection.base_ref}:**\n${c.inspection.diff_against_main}`,
    )
    .join("\n\n---\n\n");
  return [
    "You are the judge in a best-of-N code tournament. Several agents independently attempted the SAME task, each on its own worktree branch. Pick the best implementation.",
    "",
    "Original task:",
    taskMessage,
    "",
    "Candidates (diffs and logs prefetched — do NOT call any tools or inspect worktrees):",
    roster,
    "",
    "Judge on: correctness against the task, scope discipline (no unrelated edits), simplicity, and overall quality. Do NOT modify or land anything — inspection only.",
    "",
    "Return StructuredOutput: a ranking (score 0-10 each, with notes) covering EVERY candidate, plus winner_branch + winner_agent + a short rationale.",
    "",
    renderJsonContract({ example: VERDICT_EXAMPLE, name: "penumbra-tournament verdict" }),
  ].join("\n");
}

async function dispatchJudge(
  ctx: WorkflowCtx,
  prompt: string,
  defaults: FanoutDefaults,
  outDirPath: string | null,
): Promise<{
  result: FanoutTaskResult | null;
  responsePath: string | null;
  responseChars: number | null;
  writtenBody: string | null;
}> {
  const judgeTask: FanoutTask = {
    message: prompt,
    label: "judge",
    initial_agent: "executor",
    use_worktree: false,
    tool_free: true,
    max_hops: 1,
    task_type: "review_adversarial",
  };
  const fanout = await runFanout(ctx, { tasks: [judgeTask], defaults });
  const result = fanout.results[0] ?? null;
  if (!result || !result.ok || !result.response_text) {
    return { result, responsePath: null, responseChars: null, writtenBody: null };
  }
  if (!outDirPath) return { result, responsePath: null, responseChars: null, writtenBody: null };
  const artifactPath = join(outDirPath, `${sanitizeFileStem(result.label)}-0.txt`);
  try {
    const written = await ctx.fileWrite(artifactPath, result.response_text);
    if (typeof written !== "string" || written.trim().length === 0 || written !== artifactPath) {
      throw new Error("invalid response artifact write receipt");
    }
    return {
      result,
      responsePath: written,
      responseChars: result.response_text.length,
      writtenBody: result.response_text,
    };
  } catch {
    return { result, responsePath: null, responseChars: null, writtenBody: result.response_text };
  }
}

type VerdictValidation = { ok: true; verdict: Verdict } | { ok: false; error: string };

function validateVerdict(verdict: Verdict, candidates: QualifiedCandidate[]): VerdictValidation {
  const candidateMap = new Map(candidates.map((c) => [c.branch, c.agent]));
  if (candidateMap.size === 0) return { ok: false, error: "no_candidates" };
  if (!candidateMap.has(verdict.winner_branch)) {
    return { ok: false, error: "winner_branch_not_found" };
  }
  const winnerAgent = candidateMap.get(verdict.winner_branch);
  if (winnerAgent !== verdict.winner_agent) {
    return { ok: false, error: "winner_agent_mismatch" };
  }
  if (verdict.ranking.length !== candidates.length) {
    return { ok: false, error: "ranking_incomplete" };
  }
  const seenBranches = new Set<string>();
  for (const entry of verdict.ranking) {
    if (!candidateMap.has(entry.branch)) return { ok: false, error: "ranking_branch_not_found" };
    const expectedAgent = candidateMap.get(entry.branch);
    if (expectedAgent !== entry.agent) return { ok: false, error: "ranking_agent_mismatch" };
    if (seenBranches.has(entry.branch)) return { ok: false, error: "ranking_duplicate_branch" };
    seenBranches.add(entry.branch);
  }
  if (!seenBranches.has(verdict.winner_branch)) {
    return { ok: false, error: "winner_not_in_ranking" };
  }
  return { ok: true, verdict };
}

async function reinspectWinner(
  ctx: WorkflowCtx,
  winner: QualifiedCandidate,
): Promise<
  | { ok: true; value: { head_sha: string; changed: boolean } }
  | { ok: false; error: "winner_reinspection_failed" | "winner_reinspection_invalid" }
> {
  try {
    const raw = await ctx.worktreeInspect?.(winner.handoff_id);
    if (raw === null || raw === undefined) {
      return { ok: false, error: "winner_reinspection_failed" };
    }
    const reinspection = validateInspection(raw, {
      handoffId: winner.handoff_id,
      branch: winner.branch,
      project: ctx.project,
    });
    if (!reinspection.ok) return { ok: false, error: "winner_reinspection_invalid" };
    return {
      ok: true,
      value: {
        head_sha: reinspection.inspection.head_sha,
        changed: reinspection.inspection.head_sha !== winner.inspection.head_sha,
      },
    };
  } catch {
    return { ok: false, error: "winner_reinspection_failed" };
  }
}

function judgeSummary(
  result: FanoutTaskResult | null,
  responsePath: string | null,
  responseChars: number | null,
  error: string | null,
): JudgeSummary {
  return {
    handoff_id: result?.handoff_id ?? null,
    conversation_id: result?.conversation_id ?? null,
    ok: result?.ok ?? false,
    reliability_trustworthy: result?.reliability_trustworthy ?? null,
    response_path: responsePath,
    response_chars: responseChars,
    error,
  };
}

function failureResult(
  input: Input,
  summaries: CandidateSummary[],
  error: string,
  judge: JudgeSummary | null = null,
  verdict: Verdict | null = null,
  reinspection: { head_sha: string; changed: boolean } | null = null,
): TournamentResult {
  const branches = summaries.flatMap((s) =>
    s.inspection_valid && s.branch !== null ? [s.branch] : [],
  );
  return {
    ok: false,
    error,
    task_message: input.task.message,
    agents: input.agents,
    candidates: summaries,
    qualified_count: summaries.filter((summary) => summary.inspection_valid).length,
    verdict,
    winner: null,
    winner_agent: null,
    branches,
    loser_branches: branches,
    judge,
    reinspection,
  };
}

export const fn: WorkflowFn = async (
  ctx: WorkflowCtx,
  _recall: RecallBundle,
): Promise<TournamentResult> => {
  const input = inputSchema.parse(ctx.args);

  if (typeof ctx.worktreeInspect !== "function") {
    return failureResult(input, [], "missing_worktree_inspect_ctx");
  }
  if (!scopeIsSupported(input, ctx)) {
    return failureResult(input, [], "scope_override_unsupported");
  }
  if (ctx.deadline?.().expired) {
    return failureResult(input, [], "deadline_expired");
  }

  const candidateTasks = buildCandidateTasks(input);
  const fanoutDefaults = buildFanoutDefaults(input);

  ctx.progress?.("penumbra-tournament: competing", { agents: input.agents.length });
  const fanout = await runFanout(ctx, { tasks: candidateTasks, defaults: fanoutDefaults });

  const { qualified, summaries } = await inspectAndFilter(ctx, fanout.results, ctx.project);

  if (qualified.length === 0) {
    ctx.progress?.("penumbra-tournament: no qualified candidates", {
      total: fanout.results.length,
    });
    return failureResult(input, summaries, "no_qualified_candidates");
  }

  ctx.progress?.("penumbra-tournament: judging", { qualified: qualified.length });

  if (ctx.deadline?.().expired) {
    return failureResult(input, summaries, "deadline_expired_before_judge");
  }

  const outDir = resolveOutDir(ctx, input.out_dir);
  const outDirPath = outDir.ok ? outDir.path : null;
  const judgePrompt = buildJudgePrompt(input.task.message, qualified);
  const {
    result: judgeResult,
    responsePath,
    responseChars,
    writtenBody,
  } = await dispatchJudge(ctx, judgePrompt, fanoutDefaults, outDirPath);

  if (!judgeResult?.ok) {
    const error = judgeResult?.error_summary ?? "judge_failed";
    return failureResult(input, summaries, error, judgeSummary(judgeResult, null, null, error));
  }

  const parsed = parseStructured(writtenBody, VerdictSchema);
  if (!parsed.ok) {
    const error = `judge_parse_failed:${parsed.error}`;
    return failureResult(
      input,
      summaries,
      error,
      judgeSummary(judgeResult, responsePath, responseChars, error),
    );
  }

  const validation = validateVerdict(parsed.value, qualified);
  if (!validation.ok) {
    return failureResult(
      input,
      summaries,
      `verdict_invalid:${validation.error}`,
      judgeSummary(judgeResult, responsePath, responseChars, validation.error),
      parsed.value,
    );
  }

  const verdict = validation.verdict;
  const winnerCandidate = qualified.find((c) => c.branch === verdict.winner_branch);
  if (!winnerCandidate) {
    return failureResult(
      input,
      summaries,
      "verdict_invalid:winner_not_found_after_validation",
      judgeSummary(judgeResult, responsePath, responseChars, "winner_not_found_after_validation"),
      verdict,
    );
  }
  const reinspectionResult = await reinspectWinner(ctx, winnerCandidate);

  if (!reinspectionResult.ok) {
    return failureResult(
      input,
      summaries,
      reinspectionResult.error,
      judgeSummary(judgeResult, responsePath, responseChars, reinspectionResult.error),
      verdict,
    );
  }
  const reinspection = reinspectionResult.value;
  if (reinspection.changed) {
    return failureResult(
      input,
      summaries,
      "winner_head_changed",
      judgeSummary(judgeResult, responsePath, responseChars, "winner_head_changed"),
      verdict,
      reinspection,
    );
  }

  const branches = qualified.map((c) => c.branch);
  const loserBranches = branches.filter((b) => b !== verdict.winner_branch);

  ctx.progress?.("penumbra-tournament: completed", {
    winner: verdict.winner_branch,
    qualified: qualified.length,
  });

  return {
    ok: true,
    error: null,
    task_message: input.task.message,
    agents: input.agents,
    candidates: summaries,
    qualified_count: qualified.length,
    verdict,
    winner: verdict.winner_branch,
    winner_agent: verdict.winner_agent,
    branches,
    loser_branches: loserBranches,
    judge: judgeSummary(judgeResult, responsePath, responseChars, null),
    reinspection,
  };
};

const spec: WorkflowSpec = {
  name: "penumbra-tournament",
  description:
    "Best-of-N: dispatch the SAME task to K different penumbra fleet agents in parallel (each on its own worktree), inspect each candidate worktree (diff + log + head SHA), then a tool-free judge agent ranks them and picks a winner. No auto-land or cleanup.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "penumbra-tournament" }],
  recall: [],
  output: [],
  run: { kind: "ts-function" },
};

export default spec;
