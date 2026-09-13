import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { join } from "node:path";

import {
  type FanoutDefaults,
  type FanoutTask,
  type FanoutTaskResult,
  runFanout,
} from "../_shared/fanout.js";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";
import { type CandidateRef, resolveAuthoritativeCandidate } from "./candidate.js";
import { parseCheck, roundMessage, validateCheckCommand } from "./check-parse.js";
import { type FixUntilGreenInput as Input, inputSchema } from "./input.js";
import { type FixUntilGreenResult, makeRoundRecord, type RoundRecord } from "./result.js";
import { runRubricGrade } from "./rubric.js";
import { runVerifyCheck } from "./verification.js";

export type { FixUntilGreenResult, RoundRecord };
export { inputSchema };

const CHECK_LINE_MAX = 300;
const FAILURE_TAIL_MAX = 4000;

function firstNonemptyLine(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, maxLen);
  }
  return null;
}

function failureTail(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  return text.length > maxLen ? text.slice(-maxLen) : text;
}

function resolveTaskTitle(task: Input["task"]): string {
  return task.task_name ?? "Untitled task";
}

function resolveTaskName(task: Input["task"], roundIndex: number): string {
  return task.task_name ?? `fix-${String(roundIndex + 1)}`;
}

function buildFanoutTask(
  input: Input,
  roundIndex: number,
  agentForRound: string,
  prevBranch: string | null,
  prevOutput: string | null,
): FanoutTask {
  const task = input.task;
  const t: FanoutTask = {
    label: `fix#${String(roundIndex + 1)}:${agentForRound}`,
    task_name: resolveTaskName(task, roundIndex),
    initial_agent: agentForRound,
    task_class: task.task_class ?? "STANDARD",
    task_type: task.task_type ?? "implement_small",
    message: roundMessage(roundIndex, task.message, input.check, prevBranch, prevOutput),
    max_hops: 1,
  };
  if (task.branch_type) t.branch_type = task.branch_type;
  if (roundIndex === 0) {
    if (input.base && input.base !== "main") t.branch_base = input.base;
  } else {
    t.branch_base = prevBranch ?? undefined;
  }
  return t;
}

function buildFanoutDefaults(input: Input, projectId: string): FanoutDefaults {
  const defaults: FanoutDefaults = {
    project_id: projectId,
    timeout_ms: input.timeout_ms,
  };
  if (input.isolated_install !== undefined) defaults.isolated_install = input.isolated_install;
  return defaults;
}

async function writeResponseArtifact(
  ctx: WorkflowCtx,
  outDirPath: string,
  label: string,
  index: number,
  responseText: string,
): Promise<string | null> {
  const artifactPath = join(outDirPath, `${sanitizeFileStem(label)}-${String(index)}.txt`);
  try {
    const written = await ctx.fileWrite(artifactPath, responseText);
    if (typeof written !== "string" || written.trim().length === 0 || written !== artifactPath) {
      return null;
    }
    return written;
  } catch {
    return null;
  }
}

type DispatchOutcome =
  | { ok: true; result: FanoutTaskResult; candidate: CandidateRef }
  | { ok: false; reason: string };

function classifyDispatch(result: FanoutTaskResult | null): DispatchOutcome {
  if (!result) return { ok: false, reason: "agent_dropped" };
  if (result.status !== "completed") return { ok: false, reason: "chain_failed" };
  const candidate = resolveAuthoritativeCandidate(result);
  if (!candidate.ok) return { ok: false, reason: candidate.reason };
  if (typeof result.root_handoff_id !== "string" || result.root_handoff_id.length === 0) {
    return { ok: false, reason: "candidate_response_handoff_missing" };
  }
  if (result.root_handoff_id !== candidate.candidate.handoffId) {
    return { ok: false, reason: "candidate_response_handoff_mismatch" };
  }
  if (typeof result.response_text !== "string" || result.response_text.trim().length === 0) {
    return { ok: false, reason: result.error_summary ?? "missing_response" };
  }
  return { ok: true, result, candidate: candidate.candidate };
}

type RoundState = {
  prevBranch: string | null;
  prevOutput: string | null;
  consecutiveVerifyNotRun: number;
};

type VerifyOutcome = {
  status: "passed" | "failed" | "unavailable" | "not_run";
  verifierHandoffId: string | null;
  verifierBranch: string | null;
  checkExit: number | null;
  failOutput: string;
};

async function runVerification(
  ctx: WorkflowCtx,
  input: Input,
  candidate: CandidateRef,
  verifierAgent: string,
  projectId: string,
): Promise<VerifyOutcome> {
  const outcome = await runVerifyCheck(ctx, {
    check: input.check,
    candidateBranch: candidate.branch,
    candidateHandoffId: candidate.handoffId,
    verifierAgent,
    timeoutMs: input.timeout_ms,
    projectId,
  });

  if (outcome.status === "unavailable") {
    return {
      status: "unavailable",
      verifierHandoffId: outcome.verifier_handoff_id,
      verifierBranch: outcome.verifier_branch,
      checkExit: null,
      failOutput: outcome.fail_output,
    };
  }

  if (outcome.status === "failed") {
    const verifierRan = outcome.result?.ran === true;
    return {
      status: verifierRan ? "failed" : "not_run",
      verifierHandoffId: outcome.verifier_handoff_id,
      verifierBranch: outcome.verifier_branch,
      checkExit: outcome.result?.check_exit ?? null,
      failOutput: outcome.fail_output,
    };
  }

  return {
    status: "passed",
    verifierHandoffId: outcome.verifier_handoff_id,
    verifierBranch: outcome.verifier_branch,
    checkExit: outcome.result?.check_exit ?? null,
    failOutput: "",
  };
}

type RubricOutcome = {
  status: "passed" | "failed" | "unavailable";
  graderHandoffId: string | null;
  graderBranch: string | null;
  grade: unknown;
  failOutput: string;
};

async function runRubric(
  ctx: WorkflowCtx,
  input: Input,
  candidate: CandidateRef,
  graderAgent: string,
  projectId: string,
): Promise<RubricOutcome> {
  const outcome = await runRubricGrade(ctx, {
    taskMessage: input.task.message,
    taskTitle: resolveTaskTitle(input.task),
    check: input.check,
    rubric: input.rubric ?? [],
    candidateBranch: candidate.branch,
    candidateHandoffId: candidate.handoffId,
    graderAgent,
    timeoutMs: input.timeout_ms,
    projectId,
  });

  if (outcome.status === "unavailable") {
    return {
      status: "unavailable",
      graderHandoffId: outcome.grader_handoff_id,
      graderBranch: outcome.grader_branch,
      grade: null,
      failOutput: outcome.fail_output,
    };
  }

  return {
    status: outcome.status,
    graderHandoffId: outcome.grader_handoff_id,
    graderBranch: outcome.grader_branch,
    grade: outcome.grade,
    failOutput: outcome.fail_output,
  };
}

type RoundResult =
  | { kind: "green"; record: RoundRecord; branch: string | null }
  | { kind: "continue"; record: RoundRecord; branch: string | null; output: string | null }
  | { kind: "stop"; record: RoundRecord; branch: string | null; output: string | null };

type VerifyHandleResult = RoundResult;

async function handleVerifyOutcome(
  ctx: WorkflowCtx,
  roundNumber: number,
  agentForRound: string,
  r: FanoutTaskResult,
  candidate: CandidateRef,
  verify: VerifyOutcome,
  state: RoundState,
  input: Input,
  projectId: string,
): Promise<VerifyHandleResult> {
  if (verify.status === "unavailable") {
    const record = makeRoundRecord({
      round: roundNumber,
      agent: agentForRound,
      result: r,
      candidateBranch: candidate.branch,
      candidateHandoffId: candidate.handoffId,
      dispatchOk: true,
      reason: "verifier_unavailable",
      checkPassed: true,
      checkVerifyStatus: "unavailable",
      verifierHandoffId: verify.verifierHandoffId,
      verifierBranch: verify.verifierBranch,
      verified: false,
      passed: false,
    });
    return { kind: "stop", record, branch: candidate.branch, output: verify.failOutput };
  }

  if (verify.status === "failed" || verify.status === "not_run") {
    if (verify.status === "not_run") {
      state.consecutiveVerifyNotRun += 1;
    } else {
      state.consecutiveVerifyNotRun = 0;
    }
    const record = makeRoundRecord({
      round: roundNumber,
      agent: agentForRound,
      result: r,
      candidateBranch: candidate.branch,
      candidateHandoffId: candidate.handoffId,
      dispatchOk: true,
      reason: verify.status === "failed" ? "verifier_measured_fail" : "verifier_not_run",
      checkPassed: true,
      checkVerifyStatus: verify.status,
      checkExit: verify.checkExit,
      verifierHandoffId: verify.verifierHandoffId,
      verifierBranch: verify.verifierBranch,
      verified: false,
      passed: false,
    });
    state.prevOutput = verify.failOutput;
    if (state.consecutiveVerifyNotRun >= 2) {
      ctx.progress?.("penumbra-fix-until-green: verifier not run twice consecutively, stopping", {
        round: roundNumber,
      });
      return { kind: "stop", record, branch: candidate.branch, output: verify.failOutput };
    }
    return { kind: "continue", record, branch: candidate.branch, output: verify.failOutput };
  }

  state.consecutiveVerifyNotRun = 0;

  if (input.rubric && input.rubric.length > 0) {
    return await handleRubricOutcome(
      ctx,
      roundNumber,
      agentForRound,
      r,
      candidate,
      input,
      verify,
      projectId,
    );
  }

  const record = makeRoundRecord({
    round: roundNumber,
    agent: agentForRound,
    result: r,
    candidateBranch: candidate.branch,
    candidateHandoffId: candidate.handoffId,
    dispatchOk: true,
    reason: "check_passed",
    checkPassed: true,
    checkVerifyStatus: "passed",
    checkExit: verify.checkExit,
    verifierHandoffId: verify.verifierHandoffId,
    verifierBranch: verify.verifierBranch,
    verified: true,
    passed: true,
  });
  ctx.progress?.("penumbra-fix-until-green: green", {
    round: roundNumber,
    branch: candidate.branch,
  });
  return { kind: "green", record, branch: candidate.branch };
}

async function handleRubricOutcome(
  ctx: WorkflowCtx,
  roundNumber: number,
  agentForRound: string,
  r: FanoutTaskResult,
  candidate: CandidateRef,
  input: Input,
  verify: VerifyOutcome | null,
  projectId: string,
): Promise<RoundResult> {
  const checkVerifyStatus = verify ? "passed" : "skipped";
  const verified = verify !== null;
  const rubricOutcome = await runRubric(
    ctx,
    input,
    candidate,
    input.grader_agent ?? "grader",
    projectId,
  );

  ctx.progress?.("penumbra-fix-until-green: rubric grade", {
    round: roundNumber,
    status: rubricOutcome.status,
  });

  if (rubricOutcome.status === "unavailable") {
    const record = makeRoundRecord({
      round: roundNumber,
      agent: agentForRound,
      result: r,
      candidateBranch: candidate.branch,
      candidateHandoffId: candidate.handoffId,
      dispatchOk: true,
      reason: "grader_unavailable",
      checkPassed: true,
      checkVerifyStatus,
      rubricStatus: "GRADER_UNAVAILABLE",
      checkExit: verify?.checkExit ?? null,
      verifierHandoffId: verify?.verifierHandoffId ?? null,
      verifierBranch: verify?.verifierBranch ?? null,
      graderHandoffId: rubricOutcome.graderHandoffId,
      graderBranch: rubricOutcome.graderBranch,
      verified,
      passed: false,
    });
    return { kind: "stop", record, branch: candidate.branch, output: rubricOutcome.failOutput };
  }

  const rubricPassed = rubricOutcome.status === "passed";
  const record = makeRoundRecord({
    round: roundNumber,
    agent: agentForRound,
    result: r,
    candidateBranch: candidate.branch,
    candidateHandoffId: candidate.handoffId,
    dispatchOk: true,
    reason: rubricPassed ? "rubric_passed" : "rubric_failed",
    checkPassed: true,
    checkVerifyStatus,
    rubricStatus: rubricPassed ? "PASSED" : "FAILED",
    checkExit: verify?.checkExit ?? null,
    verifierHandoffId: verify?.verifierHandoffId ?? null,
    verifierBranch: verify?.verifierBranch ?? null,
    rubricGrade: rubricOutcome.grade,
    graderHandoffId: rubricOutcome.graderHandoffId,
    graderBranch: rubricOutcome.graderBranch,
    verified,
    passed: rubricPassed,
  });

  if (rubricPassed) {
    ctx.progress?.("penumbra-fix-until-green: green", {
      round: roundNumber,
      branch: candidate.branch,
    });
    return { kind: "green", record, branch: candidate.branch };
  }

  return { kind: "continue", record, branch: candidate.branch, output: rubricOutcome.failOutput };
}

type CheckOutcome =
  | {
      kind: "dispatch_fail";
      record: RoundRecord;
      prevBranch: string | null;
      prevOutput: string | null;
    }
  | { kind: "check_fail"; record: RoundRecord; branch: string | null; output: string }
  | { kind: "green_no_verify"; record: RoundRecord; branch: string | null }
  | {
      kind: "proceed";
      r: FanoutTaskResult;
      candidate: CandidateRef;
    };

async function dispatchAndCheck(
  ctx: WorkflowCtx,
  input: Input,
  roundIndex: number,
  state: RoundState,
  rounds: RoundRecord[],
  projectId: string,
): Promise<CheckOutcome> {
  const isLastRound = roundIndex === input.max_rounds - 1;
  const agentForRound = isLastRound && input.escalate_to ? input.escalate_to : input.agent;
  const roundNumber = roundIndex + 1;

  ctx.progress?.("penumbra-fix-until-green: round", {
    round: roundNumber,
    agent: agentForRound,
    max_rounds: input.max_rounds,
  });

  const fanoutTask = buildFanoutTask(
    input,
    roundIndex,
    agentForRound,
    state.prevBranch,
    state.prevOutput,
  );
  const fanoutDefaults = buildFanoutDefaults(input, projectId);

  const fan = await runFanout(ctx, { tasks: [fanoutTask], defaults: fanoutDefaults });
  const r = fan.results[0] ?? null;

  const dispatch = classifyDispatch(r);
  if (!dispatch.ok) {
    const record = makeRoundRecord({
      round: roundNumber,
      agent: agentForRound,
      result: r,
      dispatchOk: false,
      reason: dispatch.reason,
      checkPassed: false,
      checkVerifyStatus: "skipped",
      passed: false,
    });
    rounds.push(record);
    ctx.progress?.("penumbra-fix-until-green: dispatch failed", {
      round: roundNumber,
      reason: dispatch.reason,
    });
    return {
      kind: "dispatch_fail",
      record,
      prevBranch: state.prevBranch,
      prevOutput: state.prevOutput,
    };
  }

  const candidate = dispatch.candidate;
  const responseText = dispatch.result.response_text;

  if (input.out_dir && responseText) {
    const outDir = resolveOutDir(ctx, input.out_dir);
    if (outDir.ok) {
      await writeResponseArtifact(
        ctx,
        outDir.path,
        fanoutTask.label ?? `fix-${String(roundNumber)}`,
        roundIndex,
        responseText,
      );
    }
  }

  const checkLine = firstNonemptyLine(responseText, CHECK_LINE_MAX);
  const failTail = failureTail(responseText, FAILURE_TAIL_MAX);
  const verdict = parseCheck(
    { check_line: checkLine, response: responseText, failure_tail: failTail },
    "first_line",
  );

  state.prevBranch = candidate.branch;
  state.prevOutput = verdict.output;

  ctx.progress?.("penumbra-fix-until-green: check result", {
    round: roundNumber,
    passed: verdict.passed,
    branch: candidate.branch,
  });

  if (!verdict.passed) {
    const record = makeRoundRecord({
      round: roundNumber,
      agent: agentForRound,
      result: r,
      candidateBranch: candidate.branch,
      candidateHandoffId: candidate.handoffId,
      dispatchOk: true,
      reason: "check_failed",
      checkPassed: false,
      checkVerifyStatus: "skipped",
      passed: false,
    });
    rounds.push(record);
    return { kind: "check_fail", record, branch: candidate.branch, output: verdict.output };
  }

  if (!input.verify_check && !input.rubric?.length) {
    const record = makeRoundRecord({
      round: roundNumber,
      agent: agentForRound,
      result: r,
      candidateBranch: candidate.branch,
      candidateHandoffId: candidate.handoffId,
      dispatchOk: true,
      reason: "check_passed",
      checkPassed: true,
      checkVerifyStatus: "skipped",
      verified: false,
      passed: true,
    });
    rounds.push(record);
    ctx.progress?.("penumbra-fix-until-green: green", {
      round: roundNumber,
      branch: candidate.branch,
    });
    return { kind: "green_no_verify", record, branch: candidate.branch };
  }

  return { kind: "proceed", r: dispatch.result, candidate };
}

async function executeRound(
  ctx: WorkflowCtx,
  input: Input,
  roundIndex: number,
  state: RoundState,
  rounds: RoundRecord[],
  projectId: string,
): Promise<RoundResult> {
  const isLastRound = roundIndex === input.max_rounds - 1;
  const agentForRound = isLastRound && input.escalate_to ? input.escalate_to : input.agent;
  const roundNumber = roundIndex + 1;

  const check = await dispatchAndCheck(ctx, input, roundIndex, state, rounds, projectId);

  if (check.kind === "dispatch_fail") {
    return {
      kind: "stop",
      record: check.record,
      branch: check.prevBranch,
      output: check.prevOutput,
    };
  }
  if (check.kind === "check_fail") {
    return { kind: "continue", record: check.record, branch: check.branch, output: check.output };
  }
  if (check.kind === "green_no_verify") {
    return { kind: "green", record: check.record, branch: check.branch };
  }

  if (!input.verify_check) {
    const result = await handleRubricOutcome(
      ctx,
      roundNumber,
      agentForRound,
      check.r,
      check.candidate,
      input,
      null,
      projectId,
    );
    rounds.push(result.record);
    return result;
  }

  const verify = await runVerification(
    ctx,
    input,
    check.candidate,
    input.verifier_agent ?? "verifier",
    projectId,
  );
  ctx.progress?.("penumbra-fix-until-green: verify check", {
    round: roundNumber,
    status: verify.status,
  });

  const result = await handleVerifyOutcome(
    ctx,
    roundNumber,
    agentForRound,
    check.r,
    check.candidate,
    verify,
    state,
    input,
    projectId,
  );
  rounds.push(result.record);
  return result;
}

function resolveProjectScope(ctx: WorkflowCtx, input: Input): string {
  if (
    input.project_id !== undefined &&
    (typeof ctx.project !== "string" || input.project_id !== ctx.project)
  ) {
    throw new Error(
      "penumbra-fix-until-green: unsupported project_id scope override; select the project with workflow_run cwd",
    );
  }
  for (const [field, value] of [
    ["repo", input.repo],
    ["caller_cwd", input.caller_cwd],
  ] as const) {
    if (value !== undefined && value !== ctx.cwd) {
      throw new Error(
        `penumbra-fix-until-green: unsupported ${field} scope override; select the project with workflow_run cwd`,
      );
    }
  }
  if (typeof ctx.project !== "string" || ctx.project.length === 0) {
    throw new Error("penumbra-fix-until-green: project scope unavailable");
  }
  return input.project_id ?? ctx.project;
}

export const fn: WorkflowFn = async (
  ctx: WorkflowCtx,
  _recall: RecallBundle,
): Promise<FixUntilGreenResult> => {
  const input = inputSchema.parse(ctx.args);

  const checkError = validateCheckCommand(input.check, input.allow_partial_check);
  if (checkError) {
    throw new Error(`penumbra-fix-until-green: ${checkError}`);
  }
  const projectId = resolveProjectScope(ctx, input);

  const rubric = input.rubric ?? [];
  const rounds: RoundRecord[] = [];
  const state: RoundState = {
    prevBranch: null,
    prevOutput: null,
    consecutiveVerifyNotRun: 0,
  };

  for (let i = 0; i < input.max_rounds; i += 1) {
    const outcome = await executeRound(ctx, input, i, state, rounds, projectId);

    if (outcome.kind === "green") {
      return {
        ok: true,
        green: true,
        rounds_used: rounds.length,
        final_branch: outcome.branch,
        last_output: null,
        rounds,
        check: input.check,
        rubric,
      };
    }

    if (outcome.kind === "stop") {
      return {
        ok: false,
        green: false,
        rounds_used: rounds.length,
        final_branch: outcome.branch,
        last_output: outcome.output,
        rounds,
        check: input.check,
        rubric,
      };
    }

    state.prevBranch = outcome.branch;
    state.prevOutput = outcome.output;
  }

  return {
    ok: false,
    green: false,
    rounds_used: rounds.length,
    final_branch: state.prevBranch,
    last_output: state.prevOutput,
    rounds,
    check: input.check,
    rubric,
  };
};

const spec: WorkflowSpec = {
  name: "penumbra-fix-until-green",
  description:
    "Dispatch an implementation task to the penumbra fleet, then loop: each round the worker runs a check command and reports PASS/FAIL; on FAIL, re-dispatch building on the previous branch with the failure log, until green or the round cap. Optionally run an independent rubric grader after a PASS; rubric failures count as FAIL and feed the next round. Optionally escalate to a stronger agent on the final round. Nothing is landed.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "penumbra-fix-until-green" }],
  recall: [],
  output: [],
  run: { kind: "ts-function" },
};

export default spec;
