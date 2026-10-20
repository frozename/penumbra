import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { join } from "node:path";

import {
  type FanoutCtx,
  type FanoutDefaults,
  type FanoutTask,
  type FanoutTaskResult,
  runFanout,
} from "../_shared/fanout.js";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";
import { parseStructured } from "../_shared/structured.js";
import {
  buildFinalResult,
  type FleetVerifyTaskResult,
  type InspectionSummary,
  type InspectionTruncation,
  isLandable,
  isReliableCandidate,
  latestMatchingHop,
  summarizeDispatch,
  summarizeVerify,
  type VerifySummary,
} from "./result.js";
import { type Input, inputSchema, type TaskInput } from "./schema.js";
import {
  renderVerifyPrompt,
  validateVerifyReport,
  type VerifyReport,
  VerifyReportSchema,
} from "./verify-command.js";

export type { FleetVerifyResult, FleetVerifyTaskResult } from "./result.js";
export { inputSchema } from "./schema.js";

type FleetVerifyCtx = FanoutCtx;

type Candidate = {
  index: number;
  task: TaskInput;
  dispatch: FanoutTaskResult;
  handoffId: string;
  branchName: string;
};

type PreparedCandidate = Candidate & {
  before: InspectionSummary;
};

type CandidatePreparation =
  | { ok: true; candidate: PreparedCandidate }
  | { ok: false; candidate: Candidate; reason: string };

type VerifyPhaseResult = {
  fanout: FanoutTaskResult;
  report: VerifyReport | null;
  parseError: string | null;
  validationErrors: string[];
  inspection: InspectionSummary | null;
  inspectionError: string | null;
  after: InspectionSummary | null;
  afterError: string | null;
};

function buildDispatchTask(task: TaskInput, projectId: string): FanoutTask {
  const result: FanoutTask = {
    message: task.dispatch_prompt,
    label: task.name,
    task_name: task.name,
    project_id: projectId,
  };
  if (task.agent) result.initial_agent = task.agent;
  if (task.task_class) result.task_class = task.task_class;
  if (task.task_type) result.task_type = task.task_type;
  if (task.branch_base) result.branch_base = task.branch_base;
  if (task.branch_type) result.branch_type = task.branch_type;
  if (task.isolated_install !== undefined) result.isolated_install = task.isolated_install;
  return result;
}

function dispatchDefaults(input: Input, projectId: string): FanoutDefaults {
  return {
    initial_agent: "executor",
    task_type: "implement_small",
    use_worktree: true,
    project_id: projectId,
    timeout_ms: input.timeout_ms,
  };
}

function identifyCandidates(
  tasks: readonly TaskInput[],
  results: readonly FanoutTaskResult[],
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [index, dispatch] of results.entries()) {
    const task = tasks[index];
    const latest = latestMatchingHop(dispatch);
    if (task && latest?.branch_name && isReliableCandidate(dispatch)) {
      candidates.push({
        index,
        task,
        dispatch,
        handoffId: latest.handoff_id,
        branchName: latest.branch_name,
      });
    }
  }
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const WORKTREE_MODES = new Set(["symlink_mirror", "isolated_install"]);

type InspectionPhase = "candidate" | "candidate_after" | "verifier";

type InspectionExpectation = {
  phase: InspectionPhase;
  handoffId: string;
  branchName: string;
  projectId: string;
  headSha?: string;
};

type InspectionResult = { ok: true; summary: InspectionSummary } | { ok: false; reason: string };

type ValidWorktreeFields = {
  handoffId: string;
  path: string;
  branchName: string;
  storageRoot: string;
  createdAt: string;
  status: string;
  projectId?: unknown;
  worktreeMode: string;
};

type ValidInspectionFields = {
  diff_against_main: string;
  branch_log: string;
  head_sha: string;
  branch_name: string;
  dirty: boolean;
  truncation: InspectionTruncation;
};

const INSPECTION_REASONS: Record<
  InspectionPhase,
  Record<
    | "missing"
    | "failed"
    | "malformed"
    | "not_created"
    | "handoff"
    | "project"
    | "branch_internal"
    | "branch"
    | "head"
    | "dirty"
    | "truncated",
    string
  >
> = {
  candidate: {
    missing: "missing_worktree_inspection",
    failed: "worktree_inspection_failed",
    malformed: "invalid_worktree_inspection",
    not_created: "candidate_worktree_not_created",
    handoff: "foreign_worktree_handle",
    project: "candidate_project_mismatch",
    branch_internal: "worktree_branch_name_inconsistent",
    branch: "candidate_branch_mismatch",
    head: "candidate_head_mismatch",
    dirty: "candidate_dirty",
    truncated: "candidate_inspection_truncated",
  },
  candidate_after: {
    missing: "missing_worktree_inspection_after_verify",
    failed: "worktree_inspection_failed_after_verify",
    malformed: "invalid_worktree_inspection_after_verify",
    not_created: "candidate_worktree_not_created_after_verify",
    handoff: "foreign_worktree_handle_after_verify",
    project: "candidate_project_mismatch_after_verify",
    branch_internal: "candidate_after_worktree_branch_mismatch",
    branch: "candidate_branch_changed_after_verify",
    head: "candidate_moved_after_verify",
    dirty: "candidate_dirty_after_verify",
    truncated: "candidate_inspection_truncated_after_verify",
  },
  verifier: {
    missing: "missing_verifier_worktree_inspection",
    failed: "verifier_worktree_inspection_failed",
    malformed: "invalid_verifier_worktree_inspection",
    not_created: "verifier_worktree_not_created",
    handoff: "foreign_verifier_worktree_handle",
    project: "verifier_project_mismatch",
    branch_internal: "verifier_worktree_branch_mismatch",
    branch: "verifier_branch_mismatch",
    head: "verifier_head_mismatch",
    dirty: "verifier_dirty",
    truncated: "verifier_inspection_truncated",
  },
};

function isInspectionTruncation(value: unknown): value is InspectionTruncation {
  if (!isRecord(value)) return false;
  return (
    typeof value.diff_against_main === "boolean" &&
    typeof value.branch_log === "boolean" &&
    typeof value.total === "boolean"
  );
}

function hasRequiredWorktreeFields(
  worktree: Record<string, unknown>,
): worktree is Record<string, unknown> & ValidWorktreeFields {
  return (
    typeof worktree.handoffId === "string" &&
    worktree.handoffId.length > 0 &&
    typeof worktree.path === "string" &&
    worktree.path.length > 0 &&
    typeof worktree.branchName === "string" &&
    worktree.branchName.length > 0 &&
    typeof worktree.storageRoot === "string" &&
    worktree.storageRoot.length > 0 &&
    typeof worktree.createdAt === "string" &&
    worktree.createdAt.length > 0 &&
    typeof worktree.status === "string" &&
    typeof worktree.worktreeMode === "string" &&
    WORKTREE_MODES.has(worktree.worktreeMode)
  );
}

function hasRequiredInspectionFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ValidInspectionFields {
  return (
    typeof value.diff_against_main === "string" &&
    typeof value.branch_log === "string" &&
    typeof value.head_sha === "string" &&
    SHA_PATTERN.test(value.head_sha) &&
    typeof value.branch_name === "string" &&
    value.branch_name.length > 0 &&
    typeof value.dirty === "boolean" &&
    isInspectionTruncation(value.truncation)
  );
}

function worktreeBindingError(
  worktree: Record<string, unknown> & ValidWorktreeFields,
  expected: InspectionExpectation,
): string | null {
  const reasons = INSPECTION_REASONS[expected.phase];
  if (worktree.status !== "created") return reasons.not_created;
  if (worktree.handoffId !== expected.handoffId) return reasons.handoff;
  if (!("projectId" in worktree) || worktree.projectId === undefined) return null;
  if (typeof worktree.projectId !== "string" || worktree.projectId.length === 0) {
    return reasons.malformed;
  }
  return worktree.projectId === expected.projectId ? null : reasons.project;
}

function inspectionValueError(
  value: Record<string, unknown> & ValidInspectionFields,
  worktree: Record<string, unknown> & ValidWorktreeFields,
  expected: InspectionExpectation,
): string | null {
  const reasons = INSPECTION_REASONS[expected.phase];
  if (worktree.branchName !== value.branch_name) return reasons.branch_internal;
  if (value.branch_name !== expected.branchName) return reasons.branch;
  if (expected.headSha !== undefined && value.head_sha !== expected.headSha) {
    return reasons.head;
  }
  if (value.dirty) return reasons.dirty;
  if (value.truncation.diff_against_main || value.truncation.branch_log || value.truncation.total) {
    return reasons.truncated;
  }
  return null;
}

function validateInspection(value: unknown, expected: InspectionExpectation): InspectionResult {
  const malformed = INSPECTION_REASONS[expected.phase].malformed;
  if (!isRecord(value) || !isRecord(value.worktree)) return { ok: false, reason: malformed };
  const worktree = value.worktree;
  if (!hasRequiredWorktreeFields(worktree) || !hasRequiredInspectionFields(value)) {
    return { ok: false, reason: malformed };
  }
  const error =
    worktreeBindingError(worktree, expected) ?? inspectionValueError(value, worktree, expected);
  if (error !== null) return { ok: false, reason: error };
  return {
    ok: true,
    summary: {
      handoff_id: worktree.handoffId,
      head_sha: value.head_sha,
      branch_name: value.branch_name,
      project_id: typeof worktree.projectId === "string" ? worktree.projectId : null,
      dirty: value.dirty,
      truncation: value.truncation,
    },
  };
}

async function inspectBoundWorktree(
  ctx: FleetVerifyCtx,
  expected: InspectionExpectation,
): Promise<InspectionResult> {
  const reasons = INSPECTION_REASONS[expected.phase];
  if (!ctx.worktreeInspect) return { ok: false, reason: reasons.missing };
  try {
    return validateInspection(await ctx.worktreeInspect(expected.handoffId), expected);
  } catch {
    return { ok: false, reason: reasons.failed };
  }
}

async function prepareCandidate(
  ctx: FleetVerifyCtx,
  candidate: Candidate,
): Promise<CandidatePreparation> {
  const inspected = await inspectBoundWorktree(ctx, {
    phase: "candidate",
    handoffId: candidate.handoffId,
    branchName: candidate.branchName,
    projectId: ctx.project,
  });
  return inspected.ok
    ? { ok: true, candidate: { ...candidate, before: inspected.summary } }
    : { ok: false, candidate, reason: inspected.reason };
}

function verifierTaskName(name: string, index: number): string {
  const prefix = `verify:${String(index)}:`;
  return `${prefix}${name.slice(0, 120 - prefix.length)}`;
}

function buildVerifyTask(
  candidate: PreparedCandidate,
  input: Input,
  projectId: string,
): FanoutTask {
  const taskName = verifierTaskName(candidate.task.name, candidate.index);
  return {
    message: renderVerifyPrompt({
      taskName: candidate.task.name,
      candidateBranch: candidate.branchName,
      expectedTargetIdentity: candidate.before.head_sha,
      verifyCommands: input.verify_commands,
      verifyChecklist: candidate.task.verify_checklist ?? null,
    }),
    label: taskName,
    task_name: taskName,
    initial_agent: input.verify_agent,
    task_type: "review_adversarial",
    use_worktree: true,
    branch_base: candidate.before.head_sha,
    isolated_install: true,
    project_id: projectId,
    max_hops: 1,
    timeout_ms: input.timeout_ms,
  };
}

function verifyDefaults(input: Input, projectId: string): FanoutDefaults {
  return {
    initial_agent: input.verify_agent,
    task_type: "review_adversarial",
    use_worktree: true,
    isolated_install: true,
    project_id: projectId,
    timeout_ms: input.timeout_ms,
  };
}

function parseVerifyResult(
  fanout: FanoutTaskResult,
  requestedCommands: readonly string[],
  expectedIdentity: string,
): Omit<VerifyPhaseResult, "inspection" | "inspectionError" | "after" | "afterError"> {
  const parsed = parseStructured(fanout.response_text, VerifyReportSchema);
  if (!parsed.ok) {
    return { fanout, report: null, parseError: parsed.error, validationErrors: [] };
  }
  const validation = validateVerifyReport(parsed.value, requestedCommands, expectedIdentity);
  return {
    fanout,
    report: parsed.value,
    parseError: null,
    validationErrors: validation.errors,
  };
}

async function inspectAfter(
  ctx: FleetVerifyCtx,
  candidate: PreparedCandidate,
): Promise<{ summary: InspectionSummary | null; error: string | null }> {
  const inspected = await inspectBoundWorktree(ctx, {
    phase: "candidate_after",
    handoffId: candidate.handoffId,
    branchName: candidate.before.branch_name,
    projectId: ctx.project,
    headSha: candidate.before.head_sha,
  });
  return inspected.ok
    ? { summary: inspected.summary, error: null }
    : { summary: null, error: inspected.reason };
}

async function inspectVerifier(
  ctx: FleetVerifyCtx,
  candidate: PreparedCandidate,
  verifier: FanoutTaskResult,
): Promise<{ summary: InspectionSummary | null; error: string | null }> {
  const latest = latestMatchingHop(verifier);
  if (!latest?.branch_name) {
    return { summary: null, error: "verifier_latest_hop_unavailable" };
  }
  const inspected = await inspectBoundWorktree(ctx, {
    phase: "verifier",
    handoffId: latest.handoff_id,
    branchName: latest.branch_name,
    projectId: ctx.project,
    headSha: candidate.before.head_sha,
  });
  return inspected.ok
    ? { summary: inspected.summary, error: null }
    : { summary: null, error: inspected.reason };
}

async function runVerification(
  ctx: FleetVerifyCtx,
  input: Input,
  projectId: string,
  candidates: readonly PreparedCandidate[],
): Promise<VerifyPhaseResult[]> {
  if (candidates.length === 0) return [];
  const tasks = candidates.map((candidate) => buildVerifyTask(candidate, input, projectId));
  ctx.progress?.("penumbra-fleet-verify: verifying", { count: tasks.length });
  const fanout = await runFanout(ctx, { tasks, defaults: verifyDefaults(input, projectId) });
  return await Promise.all(
    fanout.results.map(async (result, index) => {
      const candidate = candidates[index];
      if (!candidate) throw new Error("verifier result index mismatch");
      if (!isReliableCandidate(result)) {
        return {
          fanout: result,
          report: null,
          parseError: null,
          validationErrors: [],
          inspection: null,
          inspectionError: null,
          after: null,
          afterError: null,
        };
      }
      const responseIsLatest = result.handoff_id === result.latest_handoff_id;
      const parsed = responseIsLatest
        ? parseVerifyResult(result, input.verify_commands, candidate.before.head_sha)
        : {
            fanout: result,
            report: null,
            parseError: null,
            validationErrors: ["verifier_response_not_bound_to_latest_hop"],
          };
      if (result.branch_base !== candidate.before.head_sha) {
        parsed.validationErrors.push("verifier_root_branch_base_mismatch");
      }
      const verifierInspection = await inspectVerifier(ctx, candidate, result);
      if (verifierInspection.error) parsed.validationErrors.push(verifierInspection.error);
      const after = await inspectAfter(ctx, candidate);
      if (after.error) parsed.validationErrors.push(after.error);
      return {
        ...parsed,
        inspection: verifierInspection.summary,
        inspectionError: verifierInspection.error,
        after: after.summary,
        afterError: after.error,
      };
    }),
  );
}

function dispatchSkipReason(dispatch: FanoutTaskResult): string {
  if (dispatch.status !== "completed") return "dispatch_failed";
  if (dispatch.latest_reliability_trustworthy !== true) return "dispatch_untrustworthy";
  if (dispatch.hops_incomplete !== false) return "dispatch_hops_incomplete";
  const latest = latestMatchingHop(dispatch);
  if (!latest) return "missing_latest_hop";
  if (latest.status !== "completed") return "latest_hop_not_completed";
  if (!latest.branch_name) return "no-branch";
  return "unknown";
}

function verifySummary(result: VerifyPhaseResult): VerifySummary {
  const summary = summarizeVerify(result.fanout);
  summary.inspection = result.inspection;
  summary.inspection_error = result.inspectionError;
  summary.report = result.report;
  summary.parse_error = result.parseError;
  summary.validation_errors = result.validationErrors;
  return summary;
}

function assembleResults(
  input: Input,
  dispatchResults: readonly FanoutTaskResult[],
  preparations: readonly CandidatePreparation[],
  prepared: readonly PreparedCandidate[],
  verifyResults: readonly VerifyPhaseResult[],
): FleetVerifyTaskResult[] {
  const preparationByIndex = new Map(preparations.map((item) => [item.candidate.index, item]));
  const verifyByIndex = new Map(prepared.map((item, i) => [item.index, verifyResults[i]]));
  return dispatchResults.map((dispatch, index) => {
    const task = input.tasks[index];
    if (!task) throw new Error("dispatch result index mismatch");
    const preparation = preparationByIndex.get(index);
    const verified = verifyByIndex.get(index);
    const result: FleetVerifyTaskResult = {
      name: task.name,
      index,
      dispatch: summarizeDispatch(dispatch),
      candidate_before: preparation?.ok ? preparation.candidate.before : null,
      candidate_before_error: preparation?.ok ? null : (preparation?.reason ?? null),
      candidate_after: verified?.after ?? null,
      candidate_after_error: verified?.afterError ?? null,
      verify: verified ? verifySummary(verified) : null,
      skipped: preparation?.ok
        ? verified?.fanout.handoff_id === null
          ? (verified.fanout.error_summary ?? "verification_not_run")
          : null
        : (preparation?.reason ?? dispatchSkipReason(dispatch)),
      artifact_receipt: null,
      artifact_error: null,
      landable: false,
    };
    result.landable = isLandable(result);
    return result;
  });
}

async function writeArtifacts(
  ctx: WorkflowCtx,
  input: Input,
  results: FleetVerifyTaskResult[],
): Promise<void> {
  if (!input.out_dir) return;
  const outDir = resolveOutDir(ctx, input.out_dir);
  if (!outDir.ok) {
    for (const result of results) result.artifact_error = "artifact_out_dir_invalid";
  } else {
    await Promise.all(
      results.map(async (result) => {
        const path = join(
          outDir.path,
          `${sanitizeFileStem(result.name)}-${String(result.index)}.json`,
        );
        try {
          const receipt = await ctx.fileWrite(path, JSON.stringify(result, null, 2));
          if (receipt !== path) throw new Error("invalid receipt");
          result.artifact_receipt = receipt;
        } catch {
          result.artifact_error = "artifact_write_failed";
        }
      }),
    );
  }
  for (const result of results) result.landable = isLandable(result);
}

export const fn: WorkflowFn = async (rawCtx: WorkflowCtx, _recall: RecallBundle) => {
  const ctx = rawCtx as FleetVerifyCtx;
  const input = inputSchema.parse(ctx.args);
  if (input.project_id !== undefined && input.project_id !== ctx.project) {
    throw new Error("project_id must match the workflow context project");
  }
  const projectId = ctx.project;
  const tasks = input.tasks.map((task) => buildDispatchTask(task, projectId));
  ctx.progress?.("penumbra-fleet-verify: dispatching", { count: tasks.length });
  const dispatch = await runFanout(ctx, {
    tasks,
    defaults: dispatchDefaults(input, projectId),
  });
  const candidates = identifyCandidates(input.tasks, dispatch.results);
  const preparations = await Promise.all(candidates.map((item) => prepareCandidate(ctx, item)));
  const prepared = preparations.flatMap((item) => (item.ok ? [item.candidate] : []));
  const verification = await runVerification(ctx, input, projectId, prepared);
  const results = assembleResults(input, dispatch.results, preparations, prepared, verification);
  await writeArtifacts(ctx, input, results);
  ctx.progress?.("penumbra-fleet-verify: completed", {
    total: results.length,
    landable: results.filter(isLandable).length,
  });
  return buildFinalResult(results);
};

const spec: WorkflowSpec = {
  name: "penumbra-fleet-verify",
  description:
    "Fan out implementation tasks, bind each trustworthy latest candidate hop to a measured immutable worktree identity, verify it in a separate isolated worktree, and land nothing.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "penumbra-fleet-verify" }],
  recall: [],
  output: [],
  run: { kind: "ts-function" },
};

export default spec;
