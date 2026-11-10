import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { join } from "node:path";

import { type FanoutTaskResult, runFanout } from "../_shared/fanout.js";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";
import { type CandidateRef } from "./candidate.js";
import { detectBlockedContract, parseCheck, validateCheckCommand } from "./check-parse.js";
import { type FixUntilGreenInput as Input, inputSchema } from "./input.js";
import {
  agentForRound,
  applyFailureDecision,
  buildFanoutDefaults,
  buildFanoutTask,
  classifyDispatch,
  failureTail,
  firstNonemptyLine,
  type ProgressState,
  resolveTaskTitle,
  rubricFailureDecision,
} from "./progress.js";
import {
  candidateRoundRecord,
  type CandidateRoundRecordOverrides,
  type CheckVerifyStatus,
  type FixUntilGreenResult,
  makeRoundRecord,
  type RoundRecord,
} from "./result.js";
import { runRubricGrade } from "./rubric.js";
import { runVerifyCheck } from "./verification.js";

export type { RepairStopReason } from "./progress.js";
export type { FixUntilGreenResult, RoundRecord } from "./result.js";
export { inputSchema };

const CHECK_LINE_MAX = 300;
const FAILURE_TAIL_MAX = 4000;

async function writeResponseArtifact(
  ctx: WorkflowCtx,
  input: Input,
  label: string,
  index: number,
  responseText: string,
): Promise<void> {
  if (input.out_dir === undefined || responseText.length === 0) return;
  const outDir = resolveOutDir(ctx, input.out_dir);
  if (!outDir.ok) return;
  const artifactPath = join(outDir.path, `${sanitizeFileStem(label)}-${String(index)}.txt`);
  try {
    const written = await ctx.fileWrite(artifactPath, responseText);
    if (typeof written !== "string" || written.trim().length === 0 || written !== artifactPath) {
      return;
    }
  } catch {
    return;
  }
}

type RoundState = ProgressState & {
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
    parityCheck: input.parity_check,
  });

  const base = {
    verifierHandoffId: outcome.verifier_handoff_id,
    verifierBranch: outcome.verifier_branch,
  };
  if (outcome.status === "unavailable") {
    return { ...base, status: "unavailable", checkExit: null, failOutput: outcome.fail_output };
  }
  if (outcome.status === "failed") {
    const verifierRan = outcome.result?.ran === true;
    return {
      ...base,
      status: verifierRan ? "failed" : "not_run",
      checkExit: outcome.result?.check_exit ?? null,
      failOutput: outcome.fail_output,
    };
  }
  return {
    ...base,
    status: "passed",
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

  const base = {
    graderHandoffId: outcome.grader_handoff_id,
    graderBranch: outcome.grader_branch,
  };
  if (outcome.status === "unavailable") {
    return { ...base, status: "unavailable", grade: null, failOutput: outcome.fail_output };
  }
  return { ...base, status: outcome.status, grade: outcome.grade, failOutput: outcome.fail_output };
}

type RoundResult =
  | { kind: "green"; record: RoundRecord; branch: string | null }
  | { kind: "continue"; record: RoundRecord; branch: string | null; output: string | null }
  | {
      kind: "stop";
      record: RoundRecord;
      branch: string | null;
      output: string | null;
      contractDefectReason?: string;
    };

function verifyFailedOutcome(
  ctx: WorkflowCtx,
  input: Input,
  roundIndex: number,
  agent: string,
  r: FanoutTaskResult,
  candidate: CandidateRef,
  verify: VerifyOutcome,
  state: RoundState,
): RoundResult {
  const roundNumber = roundIndex + 1;
  state.consecutiveVerifyNotRun = 0;
  state.prevOutput = verify.failOutput;
  const failure = applyFailureDecision(
    state,
    input,
    roundIndex,
    verify.failOutput,
    "verifier_measured_fail",
  );
  const record = candidateRoundRecord({
    round: roundNumber,
    agent,
    result: r,
    candidate,
    reason: failure.reason,
    checkPassed: true,
    checkVerifyStatus: "failed",
    checkExit: verify.checkExit,
    verifierHandoffId: verify.verifierHandoffId,
    verifierBranch: verify.verifierBranch,
    passed: false,
  });
  if (failure.stop) {
    ctx.progress?.("penumbra-fix-until-green: stopping after verifier failure", {
      round: roundNumber,
      reason: failure.reason,
    });
    return { kind: "stop", record, branch: candidate.branch, output: verify.failOutput };
  }
  return { kind: "continue", record, branch: candidate.branch, output: verify.failOutput };
}

async function handleVerifyOutcome(
  ctx: WorkflowCtx,
  roundIndex: number,
  agent: string,
  r: FanoutTaskResult,
  candidate: CandidateRef,
  verify: VerifyOutcome,
  state: RoundState,
  input: Input,
  projectId: string,
): Promise<RoundResult> {
  const roundNumber = roundIndex + 1;
  const rec = (over: CandidateRoundRecordOverrides): RoundRecord =>
    candidateRoundRecord({ round: roundNumber, agent, result: r, candidate, ...over });
  const verifierBase = {
    verifierHandoffId: verify.verifierHandoffId,
    verifierBranch: verify.verifierBranch,
  };

  if (verify.status === "unavailable") {
    const record = rec({
      reason: "verifier_unavailable",
      checkPassed: true,
      checkVerifyStatus: "unavailable",
      ...verifierBase,
      passed: false,
    });
    return { kind: "stop", record, branch: candidate.branch, output: verify.failOutput };
  }

  if (verify.status === "not_run") {
    state.consecutiveVerifyNotRun += 1;
    state.lastFailureFingerprint = null;
    state.prevOutput = verify.failOutput;
    const record = rec({
      reason: "verifier_not_run",
      checkPassed: true,
      checkVerifyStatus: "not_run",
      checkExit: verify.checkExit,
      ...verifierBase,
      passed: false,
    });
    if (state.consecutiveVerifyNotRun >= 2) {
      ctx.progress?.("penumbra-fix-until-green: verifier not run twice consecutively, stopping", {
        round: roundNumber,
      });
      return { kind: "stop", record, branch: candidate.branch, output: verify.failOutput };
    }
    return { kind: "continue", record, branch: candidate.branch, output: verify.failOutput };
  }

  if (verify.status === "failed") {
    return verifyFailedOutcome(ctx, input, roundIndex, agent, r, candidate, verify, state);
  }

  state.consecutiveVerifyNotRun = 0;

  if (input.rubric && input.rubric.length > 0) {
    return await handleRubricOutcome(
      ctx,
      roundIndex,
      agent,
      r,
      candidate,
      input,
      verify,
      state,
      projectId,
    );
  }

  const record = rec({
    reason: "check_passed",
    checkPassed: true,
    checkVerifyStatus: "passed",
    checkExit: verify.checkExit,
    ...verifierBase,
    verified: true,
    ciParity: input.parity_check !== undefined,
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
  roundIndex: number,
  agent: string,
  r: FanoutTaskResult,
  candidate: CandidateRef,
  input: Input,
  verify: VerifyOutcome | null,
  state: RoundState,
  projectId: string,
): Promise<RoundResult> {
  const roundNumber = roundIndex + 1;
  const rec = (over: CandidateRoundRecordOverrides): RoundRecord =>
    candidateRoundRecord({ round: roundNumber, agent, result: r, candidate, ...over });
  const checkVerifyStatus: CheckVerifyStatus = verify ? "passed" : "skipped";
  const verified = verify !== null;
  const ciParity = verified && input.parity_check !== undefined;
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

  const stageBase = {
    checkPassed: true,
    checkVerifyStatus,
    checkExit: verify?.checkExit ?? null,
    verifierHandoffId: verify?.verifierHandoffId ?? null,
    verifierBranch: verify?.verifierBranch ?? null,
    graderHandoffId: rubricOutcome.graderHandoffId,
    graderBranch: rubricOutcome.graderBranch,
    verified,
    ciParity,
  };

  if (rubricOutcome.status === "unavailable") {
    const record = rec({
      ...stageBase,
      reason: "grader_unavailable",
      rubricStatus: "GRADER_UNAVAILABLE",
      passed: false,
    });
    return { kind: "stop", record, branch: candidate.branch, output: rubricOutcome.failOutput };
  }

  const rubricPassed = rubricOutcome.status === "passed";
  const failure = rubricFailureDecision(state, input, roundIndex, rubricOutcome.failOutput);
  const record = rec({
    ...stageBase,
    reason: rubricPassed ? "rubric_passed" : failure.reason,
    rubricStatus: rubricPassed ? "PASSED" : "FAILED",
    rubricGrade: rubricOutcome.grade,
    passed: rubricPassed,
  });

  if (rubricPassed) {
    ctx.progress?.("penumbra-fix-until-green: green", {
      round: roundNumber,
      branch: candidate.branch,
    });
    return { kind: "green", record, branch: candidate.branch };
  }

  if (failure.stop) {
    ctx.progress?.("penumbra-fix-until-green: stopping after rubric failure", {
      round: roundNumber,
      reason: failure.reason,
    });
    return { kind: "stop", record, branch: candidate.branch, output: rubricOutcome.failOutput };
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
  | { kind: "contract_blocked"; record: RoundRecord; branch: string | null; reason: string }
  | { kind: "stop"; record: RoundRecord; branch: string | null; output: string | null }
  | { kind: "proceed"; r: FanoutTaskResult; candidate: CandidateRef };

function dispatchFailureOutcome(
  ctx: WorkflowCtx,
  roundNumber: number,
  agent: string,
  r: FanoutTaskResult | null,
  reason: string,
  state: RoundState,
  rounds: RoundRecord[],
): CheckOutcome {
  const record = makeRoundRecord({
    round: roundNumber,
    agent,
    result: r,
    dispatchOk: false,
    reason,
    checkPassed: false,
    checkVerifyStatus: "skipped",
    passed: false,
  });
  rounds.push(record);
  ctx.progress?.("penumbra-fix-until-green: dispatch failed", { round: roundNumber, reason });
  return {
    kind: "dispatch_fail",
    record,
    prevBranch: state.prevBranch,
    prevOutput: state.prevOutput,
  };
}

function contractBlockedOutcome(
  ctx: WorkflowCtx,
  roundNumber: number,
  agent: string,
  r: FanoutTaskResult,
  candidate: CandidateRef,
  reason: string,
  rounds: RoundRecord[],
): CheckOutcome {
  const record = candidateRoundRecord({
    round: roundNumber,
    agent,
    result: r,
    candidate,
    reason: "contract_defect",
    checkPassed: false,
    checkVerifyStatus: "skipped",
    passed: false,
  });
  rounds.push(record);
  ctx.progress?.("penumbra-fix-until-green: contract defect detected", {
    round: roundNumber,
    reason,
  });
  return { kind: "contract_blocked", record, branch: candidate.branch, reason };
}

function passedCheckOutcome(
  ctx: WorkflowCtx,
  input: Input,
  roundNumber: number,
  agent: string,
  r: FanoutTaskResult,
  candidate: CandidateRef,
  rounds: RoundRecord[],
): CheckOutcome {
  if (!input.verify_check && !input.rubric?.length) {
    const record = candidateRoundRecord({
      round: roundNumber,
      agent,
      result: r,
      candidate,
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
  return { kind: "proceed", r, candidate };
}

async function dispatchAndCheck(
  ctx: WorkflowCtx,
  input: Input,
  roundIndex: number,
  state: RoundState,
  rounds: RoundRecord[],
  projectId: string,
): Promise<CheckOutcome> {
  const roundNumber = roundIndex + 1;
  const agent = agentForRound(input, roundIndex, state);

  ctx.progress?.("penumbra-fix-until-green: round", {
    round: roundNumber,
    agent,
    max_rounds: input.max_rounds,
  });

  const fanoutTask = buildFanoutTask(input, roundIndex, agent, state.prevBranch, state.prevOutput);
  const fan = await runFanout(ctx, {
    tasks: [fanoutTask],
    defaults: buildFanoutDefaults(input, projectId),
  });
  const r = fan.results[0] ?? null;

  const dispatch = classifyDispatch(r);
  if (!dispatch.ok) {
    return dispatchFailureOutcome(ctx, roundNumber, agent, r, dispatch.reason, state, rounds);
  }

  const candidate = dispatch.candidate;
  const responseText = dispatch.result.response_text ?? "";

  await writeResponseArtifact(
    ctx,
    input,
    fanoutTask.label ?? `fix-${String(roundNumber)}`,
    roundIndex,
    responseText,
  );

  const checkLine = firstNonemptyLine(responseText, CHECK_LINE_MAX);
  const failTail = failureTail(responseText, FAILURE_TAIL_MAX);
  const blockedContract = detectBlockedContract([checkLine, responseText, failTail]);
  if (input.progress_stops && blockedContract !== null) {
    return contractBlockedOutcome(
      ctx,
      roundNumber,
      agent,
      dispatch.result,
      candidate,
      blockedContract.reason,
      rounds,
    );
  }

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

  if (verdict.passed) {
    return passedCheckOutcome(ctx, input, roundNumber, agent, dispatch.result, candidate, rounds);
  }

  const failure = applyFailureDecision(state, input, roundIndex, responseText, "check_failed");
  const record = candidateRoundRecord({
    round: roundNumber,
    agent,
    result: dispatch.result,
    candidate,
    reason: failure.reason,
    checkPassed: false,
    checkVerifyStatus: "skipped",
    passed: false,
  });
  rounds.push(record);
  if (failure.stop) {
    ctx.progress?.("penumbra-fix-until-green: stopping after check failure", {
      round: roundNumber,
      reason: failure.reason,
    });
    return { kind: "stop", record, branch: candidate.branch, output: verdict.output };
  }
  return { kind: "check_fail", record, branch: candidate.branch, output: verdict.output };
}

async function executeRound(
  ctx: WorkflowCtx,
  input: Input,
  roundIndex: number,
  state: RoundState,
  rounds: RoundRecord[],
  projectId: string,
): Promise<RoundResult> {
  const roundNumber = roundIndex + 1;
  const agent = agentForRound(input, roundIndex, state);

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
  if (check.kind === "contract_blocked") {
    return {
      kind: "stop",
      record: check.record,
      branch: check.branch,
      output: `CHECK_RESULT: BLOCKED ${check.reason}`,
      contractDefectReason: check.reason,
    };
  }
  if (check.kind === "stop") {
    return { kind: "stop", record: check.record, branch: check.branch, output: check.output };
  }

  if (!input.verify_check) {
    const result = await handleRubricOutcome(
      ctx,
      roundIndex,
      agent,
      check.r,
      check.candidate,
      input,
      null,
      state,
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
    roundIndex,
    agent,
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
    lastFailureFingerprint: null,
    escalated: false,
  };
  const resultBase = { rounds, check: input.check, rubric };

  for (let i = 0; i < input.max_rounds; i += 1) {
    const outcome = await executeRound(ctx, input, i, state, rounds, projectId);

    if (outcome.kind === "green") {
      return {
        ok: true,
        green: true,
        rounds_used: rounds.length,
        final_branch: outcome.branch,
        last_output: null,
        ...resultBase,
        ci_parity: outcome.record.ci_parity,
        stop_reason: null,
      };
    }

    if (outcome.kind === "stop") {
      return {
        ok: false,
        green: false,
        rounds_used: rounds.length,
        final_branch: outcome.branch,
        last_output: outcome.output,
        ...resultBase,
        ci_parity: false,
        stop_reason: outcome.record.reason,
        ...(outcome.contractDefectReason === undefined
          ? {}
          : { contract_defect_reason: outcome.contractDefectReason }),
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
    ...resultBase,
    ci_parity: false,
    stop_reason: "max_rounds",
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
