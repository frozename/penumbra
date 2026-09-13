export const meta = {
  name: "session-memory-sweep",
  description:
    "Collect close-time t2 memory candidates for approval, or write explicitly approved candidates to t2.",
  whenToUse:
    "At session close, pre-compact, or stop when you want Penumbra to propose durable memories before any t2 write.",
  phases: [
    { title: "Collect", detail: "run the daemon workflow and return candidate proposals" },
    { title: "Approve", detail: "write only explicitly approved candidates to t2" },
  ],
};

let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    throw new Error("session-memory-sweep: args is not valid JSON: " + input.slice(0, 300));
  }
}
if (!input || typeof input !== "object") input = {};

const CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "slug", "title", "body", "hook", "why"],
  properties: {
    action: { type: "string", enum: ["create", "update"] },
    slug: { type: "string" },
    update_existing_slug: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    hook: { type: "string" },
    why: { type: "string" },
    durability: { type: "string" },
    is_episodic: { type: "boolean" },
  },
};

const COLLECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "rendered_block", "candidates"],
  properties: {
    ok: { type: "boolean" },
    rendered_block: { type: "string" },
    candidates: { type: "array", items: CANDIDATE_SCHEMA },
    note: { type: "string" },
  },
};

const APPROVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "results"],
  properties: {
    ok: { type: "boolean" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          memory_id: { type: "string" },
          error: { type: "string" },
        },
      },
    },
  },
};

const VISUALLY_EMPTY_CHARS_RE = /[\s\p{Z}\u200B-\u200D\u2060\uFEFF]/gu;
function hasNonWhitespaceCharacter(value) {
  return typeof value === "string" && value.replaceAll(VISUALLY_EMPTY_CHARS_RE, "").length > 0;
}

if (Array.isArray(input.approve)) {
  phase("Approve");
  const approved = input.approve;
  const invalid = approved.flatMap((candidate, index) => {
    const slug =
      candidate &&
      candidate.action === "update" &&
      typeof candidate.update_existing_slug === "string"
        ? candidate.update_existing_slug
        : candidate?.slug;
    const errors = [];
    if (!hasNonWhitespaceCharacter(slug)) errors.push("missing non-blank slug");
    if (!hasNonWhitespaceCharacter(candidate?.hook)) errors.push("missing non-blank hook");
    return errors.length === 0
      ? []
      : [
          {
            slug: typeof slug === "string" ? slug : `candidate-${String(index + 1)}`,
            error: `candidate ${String(index + 1)}: ${errors.join("; ")}`,
          },
        ];
  });
  if (invalid.length > 0) {
    return { ok: false, results: invalid };
  }
  return await agent(
    [
      "Use ToolSearch to load the Penumbra memory_write_t2 MCP tool, then write each approved candidate verbatim.",
      "For update candidates, pass update_existing_slug as the slug when present; otherwise pass slug.",
      "Include title, body, hook, why, durability, is_episodic, and project_id if available. Do not alter candidate wording.",
      "Return one result per candidate with slug and memory_id or error.",
      "",
      "Approved candidates:",
      JSON.stringify(approved, null, 2),
      input.project_id ? `Project id: ${input.project_id}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    { label: "session-memory-sweep-approve", phase: "Approve", schema: APPROVE_SCHEMA },
  );
}

phase("Collect");
const collectCwd = input.cwd;
if (typeof collectCwd !== "string" || collectCwd.length === 0 || collectCwd[0] !== "/") {
  return { ok: false, rendered_block: "", candidates: [], error: "cwd_not_absolute" };
}
const DEFAULT_COLLECT_TIMEOUT_MS = 300000;
const MAX_COLLECT_TIMEOUT_MS = 1800000;
const collectTimeoutMs =
  typeof input.timeout_ms === "number" &&
  Number.isInteger(input.timeout_ms) &&
  input.timeout_ms > 0 &&
  input.timeout_ms <= MAX_COLLECT_TIMEOUT_MS
    ? input.timeout_ms
    : DEFAULT_COLLECT_TIMEOUT_MS;
const collectDeadlineAt = Date.now() + collectTimeoutMs;

function collectRemainingMs() {
  return Math.max(0, collectDeadlineAt - Date.now());
}

function collectFailure(error, extra) {
  return { ok: false, rendered_block: "", candidates: [], ...(extra ?? {}), error: error };
}

function collectDeadlineFailure(runId, stage, extra) {
  return collectFailure("deadline_exceeded", {
    ...(runId ? { run_id: runId } : {}),
    ...(extra ?? {}),
    status: "timeout",
    stage: stage,
  });
}

const COLLECT_START_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name_used", "cwd_used", "wait_used"],
  properties: {
    workflow_run_id: { type: "string" },
    error_code: { type: "string" },
    error_message: { type: "string" },
    resolution_warning: { type: "string" },
    name_used: { type: "string" },
    cwd_used: { type: "string" },
    wait_used: { type: "boolean" },
  },
};

const collectRunArgs = JSON.stringify({
  name: "session-memory-sweep",
  cwd: collectCwd,
  wait: false,
});

const collectStart = await agent(
  [
    "Call mcp__penumbra__workflow_run with EXACTLY these arguments (do not alter, add, or remove any field):",
    collectRunArgs,
    "Return the EXACT JSON response from the tool. If the tool returns an error, return error_code and error_message.",
    "Echo back the exact name, cwd, and wait values you passed as name_used, cwd_used, and wait_used.",
    `${String(collectRemainingMs())} ms remain in the total collect deadline. Do not do any other work.`,
  ].join("\n"),
  {
    label: "session-memory-sweep-collect-start",
    phase: "Collect",
    schema: COLLECT_START_SCHEMA,
  },
);

if (!collectStart || typeof collectStart !== "object") {
  return { ok: false, rendered_block: "", candidates: [], error: "start_no_response" };
}
if (collectStart.error_code) {
  return {
    ok: false,
    rendered_block: "",
    candidates: [],
    error: "start_error",
    error_code: collectStart.error_code,
    error_message: collectStart.error_message,
  };
}
if (collectStart.name_used !== "session-memory-sweep") {
  return { ok: false, rendered_block: "", candidates: [], error: "start_name_mismatch" };
}
if (collectStart.cwd_used !== collectCwd) {
  return { ok: false, rendered_block: "", candidates: [], error: "start_cwd_mismatch" };
}
if (collectStart.wait_used !== false) {
  return { ok: false, rendered_block: "", candidates: [], error: "start_wait_not_false" };
}
if (collectStart.resolution_warning) {
  return collectFailure("start_resolution_warning", {
    resolution_warning: collectStart.resolution_warning,
  });
}
const collectRunId = collectStart.workflow_run_id;
if (typeof collectRunId !== "string" || collectRunId.length === 0) {
  return { ok: false, rendered_block: "", candidates: [], error: "start_no_run_id" };
}
if (collectRemainingMs() === 0) {
  return collectDeadlineFailure(collectRunId, "start");
}

const COLLECT_WAIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "workflow_run_id_used",
    "cwd_used",
    "payload_read",
    "ok",
    "rendered_block",
    "candidates",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "failed", "running", "timeout"],
    },
    outcome: { type: "string" },
    result_truncated: { type: "boolean" },
    result_handle_id: { type: "string" },
    result_preview: { type: "string" },
    result_bytes: { type: "number" },
    error_truncated: { type: "boolean" },
    error_handle_id: { type: "string" },
    error_preview: { type: "string" },
    error_bytes: { type: "number" },
    workflow_run_id_used: { type: "string" },
    cwd_used: { type: "string" },
    payload_read: { type: "boolean" },
    native_outcome: { type: "string" },
    run_result_read: { type: "boolean" },
    resolution_warning: { type: "string" },
    ok: { type: "boolean" },
    rendered_block: { type: "string" },
    candidates: { type: "array", items: CANDIDATE_SCHEMA },
    note: { type: "string" },
  },
};

const COLLECT_HANDLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["handle_id_used", "payload_read", "payload_kind"],
  properties: {
    handle_id_used: { type: "string" },
    payload_read: { type: "boolean" },
    payload_kind: {
      type: "string",
      enum: ["memory_sweep_result", "workflow_error", "unknown"],
    },
    native_outcome: { type: "string" },
    run_result_read: { type: "boolean" },
    semantic_ok: { type: "boolean" },
    error_present: { type: "boolean" },
    resolution_warning: { type: "string" },
    error_code: { type: "string" },
    error_message: { type: "string" },
  },
};

async function readCollectHandle(handleId, expectedKind, remainingMs) {
  const readArgs = JSON.stringify({ handle_id: handleId });
  return await agent(
    [
      "Call mcp__penumbra__read_handle with EXACTLY these arguments (do not alter, add, or remove any field):",
      readArgs,
      "Read the COMPLETE returned text payload. Do not classify from a preview and do not return the raw payload.",
      "Set payload_read:true only after the complete payload was read; otherwise set it false and include error_code/error_message.",
      "For a native session-memory-sweep ExecuteResult, set payload_kind:memory_sweep_result, copy its outcome as native_outcome, set run_result_read:true only after reading the complete runResult Markdown, and set semantic_ok:true only when that Markdown is a valid candidates block or the explicit no-new-candidates result.",
      "For a readable error body, set payload_kind:workflow_error and error_present:true.",
      `The expected payload kind is ${expectedKind}.`,
      "Echo back the exact handle_id passed to the tool as handle_id_used.",
      `${String(remainingMs)} ms remain in the total collect deadline. Do not do any other work.`,
    ].join("\n"),
    {
      label: "session-memory-sweep-collect-read-handle",
      phase: "Collect",
      schema: COLLECT_HANDLE_SCHEMA,
    },
  );
}

function collectSpillFields(waitResult, field) {
  return {
    run_id: collectRunId,
    [`${field}_handle_id`]: waitResult[`${field}_handle_id`],
    [`${field}_preview`]: waitResult[`${field}_preview`],
    [`${field}_bytes`]: waitResult[`${field}_bytes`],
  };
}

const collectWaitTimeoutMs = collectRemainingMs();
const collectWaitArgs = JSON.stringify({
  workflow_run_id: collectRunId,
  cwd: collectCwd,
  timeout_ms: collectWaitTimeoutMs,
});

const collectWait = await agent(
  [
    "Call mcp__penumbra__workflow_wait with EXACTLY these arguments (do not alter, add, or remove any field):",
    collectWaitArgs,
    "Return the EXACT status, outcome, result/error truncation fields, handle ids, previews, and byte counts from the tool response.",
    "Echo back the exact workflow_run_id and cwd values you passed as workflow_run_id_used and cwd_used.",
    "Set payload_read:true only after reading the complete workflow_wait response envelope, including inline payload or truncation metadata.",
    "If status is completed and result is present, copy result.outcome as native_outcome, read the COMPLETE result.runResult Markdown, set run_result_read:true, and extract rendered_block and candidates from it.",
    "If the result is empty or says 'no new candidates', return ok:true with rendered_block:'' and candidates:[].",
    "Do not call memory_write_t2 in collect mode.",
    `${String(collectWaitTimeoutMs)} ms remain in the total collect deadline. Do not do any other work.`,
  ].join("\n"),
  {
    label: "session-memory-sweep-collect-wait",
    phase: "Collect",
    schema: COLLECT_WAIT_SCHEMA,
  },
);

if (!collectWait || typeof collectWait !== "object") {
  return { ok: false, rendered_block: "", candidates: [], error: "wait_no_response" };
}
if (collectWait.workflow_run_id_used !== collectRunId) {
  return { ok: false, rendered_block: "", candidates: [], error: "wait_run_id_mismatch" };
}
if (collectWait.cwd_used !== collectCwd) {
  return collectFailure("wait_cwd_mismatch", { run_id: collectRunId });
}
if (collectWait.payload_read !== true) {
  return collectFailure("wait_payload_not_read", { run_id: collectRunId });
}
if (collectWait.resolution_warning) {
  return collectFailure("wait_resolution_warning", {
    run_id: collectRunId,
    resolution_warning: collectWait.resolution_warning,
  });
}
if (collectRemainingMs() === 0) {
  return collectDeadlineFailure(collectRunId, "wait");
}
if (collectWait.status === "timeout") {
  return collectFailure("wait_timeout", { run_id: collectRunId });
}

if (collectWait.error_truncated === true) {
  const handleId = collectWait.error_handle_id;
  const fields = collectSpillFields(collectWait, "error");
  if (typeof handleId !== "string" || handleId.length === 0) {
    return collectFailure("error_handle_missing", fields);
  }
  const remainingMs = collectRemainingMs();
  if (remainingMs === 0) return collectDeadlineFailure(collectRunId, "read_handle", fields);
  const readResult = await readCollectHandle(handleId, "workflow_error", remainingMs);
  if (collectRemainingMs() === 0) {
    return collectDeadlineFailure(collectRunId, "read_handle", fields);
  }
  if (!readResult || typeof readResult !== "object") {
    return collectFailure("handle_resolution_no_response", fields);
  }
  if (readResult.handle_id_used !== handleId) {
    return collectFailure("handle_id_mismatch", { ...fields, actual: readResult.handle_id_used });
  }
  if (readResult.error_code) {
    return collectFailure("handle_resolution_error", {
      ...fields,
      error_code: readResult.error_code,
      error_message: readResult.error_message,
    });
  }
  if (readResult.payload_read !== true) return collectFailure("handle_payload_not_read", fields);
  if (readResult.resolution_warning) {
    return collectFailure("handle_resolution_warning", {
      ...fields,
      resolution_warning: readResult.resolution_warning,
    });
  }
  if (readResult.payload_kind !== "workflow_error" || readResult.error_present !== true) {
    return collectFailure("handle_payload_malformed", fields);
  }
  return collectFailure("workflow_error", { ...fields, payload_read: true });
}

if (collectWait.result_truncated === true) {
  const handleId = collectWait.result_handle_id;
  const fields = collectSpillFields(collectWait, "result");
  if (typeof handleId !== "string" || handleId.length === 0) {
    return collectFailure("result_handle_missing", fields);
  }
  const remainingMs = collectRemainingMs();
  if (remainingMs === 0) return collectDeadlineFailure(collectRunId, "read_handle", fields);
  const readResult = await readCollectHandle(handleId, "memory_sweep_result", remainingMs);
  if (collectRemainingMs() === 0) {
    return collectDeadlineFailure(collectRunId, "read_handle", fields);
  }
  if (!readResult || typeof readResult !== "object") {
    return collectFailure("handle_resolution_no_response", fields);
  }
  if (readResult.handle_id_used !== handleId) {
    return collectFailure("handle_id_mismatch", { ...fields, actual: readResult.handle_id_used });
  }
  if (readResult.error_code) {
    return collectFailure("handle_resolution_error", {
      ...fields,
      error_code: readResult.error_code,
      error_message: readResult.error_message,
    });
  }
  if (readResult.payload_read !== true) return collectFailure("handle_payload_not_read", fields);
  if (readResult.resolution_warning) {
    return collectFailure("handle_resolution_warning", {
      ...fields,
      resolution_warning: readResult.resolution_warning,
    });
  }
  if (
    readResult.payload_kind !== "memory_sweep_result" ||
    readResult.native_outcome !== "success" ||
    readResult.run_result_read !== true ||
    readResult.semantic_ok !== true
  ) {
    return collectFailure("handle_payload_malformed", fields);
  }
  if (collectWait.outcome !== "success" || collectWait.status !== "completed") {
    return collectFailure("wait_not_completed", fields);
  }
  return {
    ok: true,
    rendered_block: "",
    candidates: [],
    ...fields,
    payload_read: true,
  };
}

if (collectWait.status !== "completed") {
  return collectFailure("wait_not_completed", { run_id: collectRunId });
}
if (collectWait.outcome !== "success") {
  return collectFailure(
    ["run_error", "render_error", "gated_failure"].includes(collectWait.outcome)
      ? "workflow_failed"
      : "unknown_outcome",
    { run_id: collectRunId },
  );
}
if (collectWait.native_outcome !== collectWait.outcome) {
  return collectFailure("contradictory_outcome", { run_id: collectRunId });
}
if (collectWait.run_result_read !== true) {
  return collectFailure("missing_semantic_payload", { run_id: collectRunId });
}
if (collectWait.ok !== true) {
  return collectFailure("inner_failure", { run_id: collectRunId });
}
if (typeof collectWait.rendered_block !== "string" || !Array.isArray(collectWait.candidates)) {
  return collectFailure("invalid_semantic_payload", { run_id: collectRunId });
}
return {
  ok: true,
  rendered_block: collectWait.rendered_block,
  candidates: collectWait.candidates,
  run_id: collectRunId,
  payload_read: true,
  ...(collectWait.note ? { note: collectWait.note } : {}),
};
