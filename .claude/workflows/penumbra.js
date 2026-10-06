export const meta = {
  name: "penumbra",
  description:
    "Generic Claude Code bridge to the Penumbra native workflow runtime. Starts a workflow with wait:false via an agent proxy, then bounded-waits for the result, locally validating every proxy receipt. No auto-land.",
  whenToUse:
    "When a CC session needs to run a Penumbra native workflow through MCP with explicit absolute scope and validated results. Pass { workflow, cwd, args?, timeout_ms? }. The cwd must be an absolute path. timeout_ms is the total budget (default 300000, max 1800000), split without reading a clock: the workflow_run start call and the read_handle call each get min(30000, floor(timeout_ms / 10)) ms and workflow_wait gets the remainder as its enforced timeout_ms. workflow_run, read_handle and agent() accept no timeout, so those two shares are advisory prompt text only.",
  phases: [
    {
      title: "Validate",
      detail: "validate explicit absolute cwd and workflow name before any expenditure",
    },
    { title: "Start", detail: "one workflow_run wait:false via agent proxy" },
    { title: "Wait", detail: "bounded workflow_wait with same cwd; locally validate receipt" },
  ],
};

const FAILED_OUTCOMES = new Set(["run_error", "render_error", "gated_failure"]);
const SUCCESS_OUTCOME = "success";
const SEMANTIC_SUCCESS_OUTCOMES = new Set(["success", "success_partial"]);
const SEMANTIC_FAILED_OUTCOMES = new Set([
  "failed",
  "canceled",
  "cancelled",
  "run_error",
  "render_error",
  "gated_failure",
]);
const SEMANTIC_SUCCESS_STATUSES = new Set(["completed"]);
const SEMANTIC_FAILED_STATUSES = new Set(["failed", "canceled", "cancelled", "timeout", "error"]);
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 1800000;

let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    throw new Error("penumbra: args is not valid JSON: " + input.slice(0, 300));
  }
}
if (!input || typeof input !== "object") input = {};

const workflow = input.workflow;
const cwd = input.cwd;
const workflowArgs = input.args;
const timeoutMs = input.timeout_ms;

if (typeof workflow !== "string" || workflow.trim().length === 0) {
  return { ok: false, error: "no_workflow" };
}
if (typeof cwd !== "string" || cwd.length === 0 || cwd[0] !== "/") {
  return { ok: false, error: "cwd_not_absolute" };
}
if (
  workflowArgs !== undefined &&
  (typeof workflowArgs !== "object" || workflowArgs === null || Array.isArray(workflowArgs))
) {
  return { ok: false, error: "invalid_args" };
}
const effectiveTimeout =
  typeof timeoutMs === "number" &&
  Number.isInteger(timeoutMs) &&
  timeoutMs > 0 &&
  timeoutMs <= MAX_TIMEOUT_MS
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
// No clock or RNG reads are allowed, so split the total up front into advisory shares and the enforced wait remainder.
const AUX_STAGE_BUDGET_MS = Math.min(30000, Math.floor(effectiveTimeout / 10));
const startBudgetMs = AUX_STAGE_BUDGET_MS;
const readHandleBudgetMs = AUX_STAGE_BUDGET_MS;
const waitBudgetMs = effectiveTimeout - startBudgetMs - readHandleBudgetMs;

const runCallArgs = JSON.stringify({
  name: workflow,
  cwd: cwd,
  wait: false,
  ...(workflowArgs !== undefined ? { args: workflowArgs } : {}),
});

const START_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name_used", "cwd_used", "wait_used"],
  properties: {
    workflow_run_id: { type: "string" },
    started_at: { type: "number" },
    resolution_warning: { type: "string" },
    error_code: { type: "string" },
    error_message: { type: "string" },
    name_used: { type: "string" },
    cwd_used: { type: "string" },
    wait_used: { type: "boolean" },
  },
};

phase("Start");
const startResult = await agent(
  [
    "Call mcp__penumbra__workflow_run with EXACTLY these arguments (do not alter, add, or remove any field):",
    runCallArgs,
    "Return the EXACT JSON response from the tool. Do not interpret, summarize, or alter it.",
    "If the tool returns an error, return error_code and error_message from the error object.",
    "Echo back the exact name, cwd, and wait values you passed to the tool as name_used, cwd_used, and wait_used.",
    `${String(startBudgetMs)} ms is this call's budget out of a ${String(effectiveTimeout)} ms total. Do not do any other work.`,
  ].join("\n"),
  {
    label: "penumbra-bridge-start",
    phase: "Start",
    schema: START_SCHEMA,
  },
);

if (!startResult || typeof startResult !== "object") {
  return { ok: false, error: "start_no_response" };
}
if (startResult.error_code) {
  return {
    ok: false,
    error: "start_error",
    error_code: startResult.error_code,
    error_message: startResult.error_message,
  };
}
if (startResult.name_used !== workflow) {
  return {
    ok: false,
    error: "start_name_mismatch",
    expected: workflow,
    actual: startResult.name_used,
  };
}
if (startResult.cwd_used !== cwd) {
  return {
    ok: false,
    error: "start_cwd_mismatch",
    expected: cwd,
    actual: startResult.cwd_used,
  };
}
if (startResult.wait_used !== false) {
  return { ok: false, error: "start_wait_not_false" };
}
if (startResult.resolution_warning) {
  return {
    ok: false,
    error: "start_resolution_warning",
    resolution_warning: startResult.resolution_warning,
  };
}
const runId = startResult.workflow_run_id;
if (typeof runId !== "string" || runId.length === 0) {
  return { ok: false, error: "start_no_run_id" };
}
const waitTimeoutMs = waitBudgetMs;
const waitCallArgs = JSON.stringify({
  workflow_run_id: runId,
  cwd: cwd,
  timeout_ms: waitTimeoutMs,
});

const WAIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "workflow_run_id_used", "cwd_used", "payload_read"],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "failed", "running", "timeout"],
    },
    started_at: { type: "number" },
    finished_at: { type: "number" },
    result_bytes: { type: "number" },
    error_bytes: { type: "number" },
    outcome: { type: "string" },
    result: {},
    error: {},
    result_truncated: { type: "boolean" },
    result_preview: { type: "string" },
    result_handle_id: { type: "string" },
    error_truncated: { type: "boolean" },
    error_preview: { type: "string" },
    error_handle_id: { type: "string" },
    workflow_run_id_used: { type: "string" },
    cwd_used: { type: "string" },
    payload_read: { type: "boolean" },
    resolution_warning: { type: "string" },
  },
};

const HANDLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["handle_id_used", "payload_read", "payload_kind"],
  properties: {
    handle_id_used: { type: "string" },
    payload_read: { type: "boolean" },
    payload_kind: { type: "string", enum: ["workflow_result", "workflow_error", "unknown"] },
    native_outcome: { type: "string" },
    has_run_result: { type: "boolean" },
    semantic_claimed: { type: "boolean" },
    semantic_malformed: { type: "boolean" },
    semantic_ok: { type: "boolean" },
    semantic_outcome: { type: "string" },
    semantic_status: { type: "string" },
    error_present: { type: "boolean" },
    resolution_warning: { type: "string" },
    error_code: { type: "string" },
    error_message: { type: "string" },
  },
};

async function readSpilledPayload(handleId, expectedKind, budgetMs) {
  const readCallArgs = JSON.stringify({ handle_id: handleId });
  phase("Resolve");
  return await agent(
    [
      "Call mcp__penumbra__read_handle with EXACTLY these arguments (do not alter, add, or remove any field):",
      readCallArgs,
      "Read the COMPLETE returned text payload. Do not classify from a preview and do not return the raw payload.",
      "Set payload_read:true only after the complete payload was read; otherwise set it false and include error_code/error_message.",
      "Classify a native ExecuteResult object as payload_kind:workflow_result and report native_outcome and whether runResult is present.",
      "Set semantic_claimed:true only when runResult is a non-array object with an own ok field, a supported outcome string (success, success_partial, failed, canceled, cancelled, run_error, render_error, gated_failure), or a supported status string (completed, failed, canceled, cancelled, timeout, error); otherwise set it false.",
      "When semantic_claimed is true, report boolean ok as semantic_ok and only supported outcome/status strings as semantic_outcome/semantic_status. Set semantic_malformed:true only when an own ok field is not boolean; arbitrary or unsupported outcome/status fields are opaque domain data, not malformed semantic claims.",
      "Classify a readable error body as payload_kind:workflow_error with error_present:true.",
      `The expected payload kind is ${expectedKind}.`,
      "Echo back the exact handle_id passed to the tool as handle_id_used.",
      `${String(budgetMs)} ms is this call's budget out of a ${String(effectiveTimeout)} ms total. Do not do any other work.`,
    ].join("\n"),
    {
      label: "penumbra-bridge-read-handle",
      phase: "Resolve",
      schema: HANDLE_SCHEMA,
    },
  );
}

function boundedSpillResult(waitResult, runId, field) {
  const prefix = field === "result" ? "result" : "error";
  return {
    run_id: runId,
    status: waitResult.status,
    outcome: waitResult.outcome,
    [`${prefix}_handle_id`]: waitResult[`${prefix}_handle_id`],
    [`${prefix}_preview`]: waitResult[`${prefix}_preview`],
    [`${prefix}_bytes`]: waitResult[`${prefix}_bytes`],
  };
}

function validateRequiredOutcome(value, missingError, malformedError) {
  if (value === undefined) return missingError;
  if (typeof value !== "string") return malformedError;
  if (value !== SUCCESS_OUTCOME && !FAILED_OUTCOMES.has(value)) return "unknown_outcome";
  return null;
}

function classifySemanticResult(semanticResult) {
  const executionSuccess = { error: null, qualification: "execution_success" };
  if (
    typeof semanticResult !== "object" ||
    semanticResult === null ||
    Array.isArray(semanticResult)
  ) {
    return executionSuccess;
  }
  const hasOk = Object.prototype.hasOwnProperty.call(semanticResult, "ok");
  const semanticOk = semanticResult.ok;
  const semanticOutcome = semanticResult.outcome;
  const semanticStatus = semanticResult.status;
  const hasSemanticOutcome =
    typeof semanticOutcome === "string" &&
    (SEMANTIC_SUCCESS_OUTCOMES.has(semanticOutcome) ||
      SEMANTIC_FAILED_OUTCOMES.has(semanticOutcome));
  const hasSemanticStatus =
    typeof semanticStatus === "string" &&
    (SEMANTIC_SUCCESS_STATUSES.has(semanticStatus) || SEMANTIC_FAILED_STATUSES.has(semanticStatus));
  if (!hasOk && !hasSemanticOutcome && !hasSemanticStatus) return executionSuccess;
  if (hasOk && typeof semanticOk !== "boolean") {
    return { error: "malformed_semantic_claim", qualification: null };
  }
  if (
    semanticOk === false ||
    (hasSemanticOutcome && SEMANTIC_FAILED_OUTCOMES.has(semanticOutcome)) ||
    (hasSemanticStatus && SEMANTIC_FAILED_STATUSES.has(semanticStatus))
  ) {
    return { error: "inner_failure", qualification: null };
  }
  return { error: null, qualification: "application_success" };
}

function classifyResolvedSemanticReceipt(readResult) {
  if (
    typeof readResult.semantic_claimed !== "boolean" ||
    typeof readResult.semantic_malformed !== "boolean" ||
    readResult.semantic_malformed
  ) {
    return { error: "malformed_semantic_claim", qualification: null };
  }
  const hasOk = Object.prototype.hasOwnProperty.call(readResult, "semantic_ok");
  const hasOutcome = Object.prototype.hasOwnProperty.call(readResult, "semantic_outcome");
  const hasStatus = Object.prototype.hasOwnProperty.call(readResult, "semantic_status");
  if (!readResult.semantic_claimed) {
    if (hasOk || hasOutcome || hasStatus) {
      return { error: "contradictory_semantic_receipt", qualification: null };
    }
    return { error: null, qualification: "execution_success" };
  }
  if (!hasOk && !hasOutcome && !hasStatus) {
    return { error: "malformed_semantic_claim", qualification: null };
  }
  if (
    (hasOutcome &&
      !SEMANTIC_SUCCESS_OUTCOMES.has(readResult.semantic_outcome) &&
      !SEMANTIC_FAILED_OUTCOMES.has(readResult.semantic_outcome)) ||
    (hasStatus &&
      !SEMANTIC_SUCCESS_STATUSES.has(readResult.semantic_status) &&
      !SEMANTIC_FAILED_STATUSES.has(readResult.semantic_status))
  ) {
    return { error: "contradictory_semantic_receipt", qualification: null };
  }
  return classifySemanticResult({
    ...(hasOk ? { ok: readResult.semantic_ok } : {}),
    ...(hasOutcome ? { outcome: readResult.semantic_outcome } : {}),
    ...(hasStatus ? { status: readResult.semantic_status } : {}),
  });
}

function validateResolvedWorkflowResult(readResult, expectedHandle, expectedOutcome) {
  if (!readResult || typeof readResult !== "object") {
    return { error: "handle_resolution_no_response", qualification: null };
  }
  if (readResult.handle_id_used !== expectedHandle) {
    return { error: "handle_id_mismatch", qualification: null };
  }
  if (readResult.error_code) return { error: "handle_resolution_error", qualification: null };
  if (readResult.payload_read !== true) {
    return { error: "handle_payload_not_read", qualification: null };
  }
  if (readResult.resolution_warning) {
    return { error: "handle_resolution_warning", qualification: null };
  }
  if (readResult.payload_kind !== "workflow_result") {
    return { error: "handle_payload_malformed", qualification: null };
  }
  const nativeOutcomeError = validateRequiredOutcome(
    readResult.native_outcome,
    "missing_native_outcome",
    "malformed_native_outcome",
  );
  if (nativeOutcomeError) return { error: nativeOutcomeError, qualification: null };
  if (readResult.native_outcome !== expectedOutcome) {
    return { error: "contradictory_outcome", qualification: null };
  }
  if (FAILED_OUTCOMES.has(expectedOutcome)) {
    return { error: "workflow_failed", qualification: null };
  }
  if (expectedOutcome !== SUCCESS_OUTCOME) {
    return { error: "unknown_outcome", qualification: null };
  }
  if (readResult.has_run_result !== true) {
    return { error: "missing_semantic_payload", qualification: null };
  }
  return classifyResolvedSemanticReceipt(readResult);
}

phase("Wait");
const waitResult = await agent(
  [
    "Call mcp__penumbra__workflow_wait with EXACTLY these arguments (do not alter, add, or remove any field):",
    waitCallArgs,
    "Return the EXACT JSON response from the tool. Do not interpret, summarize, or alter it.",
    "If result_truncated or error_truncated is true, return the handle_id, preview, and bytes verbatim.",
    "Set payload_read:true only after reading the complete workflow_wait response envelope, including its inline payload or truncation metadata; otherwise set payload_read:false.",
    "Echo back the exact workflow_run_id and cwd values you passed to the tool as workflow_run_id_used and cwd_used.",
    `${String(waitTimeoutMs)} ms is this call's budget out of a ${String(effectiveTimeout)} ms total. Do not do any other work.`,
  ].join("\n"),
  {
    label: "penumbra-bridge-wait",
    phase: "Wait",
    schema: WAIT_SCHEMA,
  },
);

if (!waitResult || typeof waitResult !== "object") {
  return { ok: false, run_id: runId, error: "wait_no_response" };
}
if (waitResult.workflow_run_id_used !== runId) {
  return {
    ok: false,
    run_id: runId,
    error: "wait_run_id_mismatch",
    expected: runId,
    actual: waitResult.workflow_run_id_used,
  };
}
if (waitResult.cwd_used !== cwd) {
  return {
    ok: false,
    run_id: runId,
    error: "wait_cwd_mismatch",
    expected: cwd,
    actual: waitResult.cwd_used,
  };
}
if (waitResult.payload_read !== true) {
  return { ok: false, run_id: runId, status: waitResult.status, error: "wait_payload_not_read" };
}
if (waitResult.resolution_warning) {
  return {
    ok: false,
    run_id: runId,
    status: waitResult.status,
    error: "wait_resolution_warning",
    resolution_warning: waitResult.resolution_warning,
  };
}
const status = waitResult.status;
const outcome = waitResult.outcome;
if (status === "timeout") {
  return { ok: false, run_id: runId, status: "timeout", error: "wait_timeout" };
}
if (status === "running") {
  return { ok: false, run_id: runId, status: status, error: "wait_not_completed" };
}

if (waitResult.error_truncated === true) {
  const errorHandleId = waitResult.error_handle_id;
  const bounded = boundedSpillResult(waitResult, runId, "error");
  if (typeof errorHandleId !== "string" || errorHandleId.length === 0) {
    return { ok: false, ...bounded, error: "error_handle_missing" };
  }
  const readResult = await readSpilledPayload(errorHandleId, "workflow_error", readHandleBudgetMs);
  if (!readResult || typeof readResult !== "object") {
    return { ok: false, ...bounded, error: "handle_resolution_no_response" };
  }
  if (readResult.handle_id_used !== errorHandleId) {
    return {
      ok: false,
      ...bounded,
      error: "handle_id_mismatch",
      actual: readResult.handle_id_used,
    };
  }
  if (readResult.error_code) {
    return {
      ok: false,
      ...bounded,
      error: "handle_resolution_error",
      error_code: readResult.error_code,
      error_message: readResult.error_message,
    };
  }
  if (readResult.payload_read !== true) {
    return { ok: false, ...bounded, error: "handle_payload_not_read" };
  }
  if (readResult.resolution_warning) {
    return {
      ok: false,
      ...bounded,
      error: "handle_resolution_warning",
      resolution_warning: readResult.resolution_warning,
    };
  }
  if (readResult.payload_kind !== "workflow_error" || readResult.error_present !== true) {
    return { ok: false, ...bounded, error: "handle_payload_malformed" };
  }
  return { ok: false, ...bounded, payload_read: true, error: "workflow_error" };
}

if (waitResult.result_truncated === true) {
  const resultHandleId = waitResult.result_handle_id;
  const bounded = boundedSpillResult(waitResult, runId, "result");
  if (typeof resultHandleId !== "string" || resultHandleId.length === 0) {
    return { ok: false, ...bounded, error: "result_handle_missing" };
  }
  const outcomeError = validateRequiredOutcome(outcome, "missing_outcome", "malformed_outcome");
  if (outcomeError) return { ok: false, ...bounded, error: outcomeError };
  const readResult = await readSpilledPayload(resultHandleId, "workflow_result", readHandleBudgetMs);
  const resolution = validateResolvedWorkflowResult(readResult, resultHandleId, outcome);
  if (resolution.error) {
    return {
      ok: false,
      ...bounded,
      ...(readResult?.payload_read === true ? { payload_read: true } : {}),
      error: resolution.error,
      ...(resolution.error === "handle_id_mismatch" ? { actual: readResult?.handle_id_used } : {}),
      ...(resolution.error === "handle_resolution_error"
        ? { error_code: readResult?.error_code, error_message: readResult?.error_message }
        : {}),
      ...(resolution.error === "handle_resolution_warning"
        ? { resolution_warning: readResult?.resolution_warning }
        : {}),
    };
  }
  if (status !== "completed") {
    return { ok: false, ...bounded, payload_read: true, error: "wait_not_completed" };
  }
  return {
    ok: true,
    ...bounded,
    payload_read: true,
    result_qualification: resolution.qualification,
  };
}

if (status !== "completed") {
  return { ok: false, run_id: runId, status: status, error: "wait_not_completed" };
}

if (waitResult.result === undefined || waitResult.result === null) {
  return { ok: false, run_id: runId, status: "completed", error: "wait_no_result" };
}

const result = waitResult.result;
if (typeof result !== "object" || result === null || Array.isArray(result)) {
  return {
    ok: false,
    run_id: runId,
    status: "completed",
    outcome: outcome,
    error: "invalid_native_result",
  };
}
const outcomeError = validateRequiredOutcome(outcome, "missing_outcome", "malformed_outcome");
if (outcomeError) {
  return {
    ok: false,
    run_id: runId,
    status: "completed",
    ...(outcomeError === "unknown_outcome" ? { outcome: outcome } : {}),
    error: outcomeError,
  };
}
const nativeOutcomeError = validateRequiredOutcome(
  result.outcome,
  "missing_native_outcome",
  "malformed_native_outcome",
);
if (nativeOutcomeError) {
  return {
    ok: false,
    run_id: runId,
    status: "completed",
    outcome: outcome,
    error: nativeOutcomeError,
  };
}
if (result.outcome !== outcome) {
  return {
    ok: false,
    run_id: runId,
    status: "completed",
    outcome: outcome,
    error: "contradictory_outcome",
  };
}
if (FAILED_OUTCOMES.has(outcome)) {
  return {
    ok: false,
    run_id: runId,
    status: "completed",
    outcome: outcome,
    error: "workflow_failed",
  };
}
if (!Object.prototype.hasOwnProperty.call(result, "runResult")) {
  return {
    ok: false,
    run_id: runId,
    status: "completed",
    outcome: outcome,
    error: "missing_semantic_payload",
  };
}

const semantic = classifySemanticResult(result.runResult);
if (semantic.error) {
  return {
    ok: false,
    run_id: runId,
    status: "completed",
    outcome: outcome,
    error: semantic.error,
    result: result,
  };
}

return {
  ok: true,
  run_id: runId,
  status: "completed",
  outcome: outcome,
  result: result,
  result_qualification: semantic.qualification,
};
