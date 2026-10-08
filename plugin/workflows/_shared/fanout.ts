import type {
  ChainStartRequest,
  DispatchRecommendedAction,
  DispatchReliabilityStatus,
  PermissionProfile,
  TaskClass,
} from "@penumbra/core";
import type { WorkflowCtx } from "@penumbra/workflows";
import type { Database } from "bun:sqlite";

import {
  awaitChainOrCancel,
  cancelChainQuietly,
  type CancelOutcome,
  DEFAULT_WAIT_TIMEOUT_MS,
} from "./await-or-cancel.js";
import {
  type FanoutHop,
  type FanoutHopEvidence,
  readFanoutHopEvidence,
  unknownFanoutHopEvidence,
} from "./fanout-hop-evidence.js";

const DEFAULT_RETRY_BACKOFF_MS = 5_000;
const MAX_WORKER_UNAVAILABLE_RETRIES = 1;
const WORKER_UNAVAILABLE_CODES = new Set(["no_worker_registered", "worker_heartbeats_stale"]);

type TaskType = NonNullable<ChainStartRequest["task_type"]>;
type TrustMode = NonNullable<ChainStartRequest["trust_mode"]>;

export type FanoutTask = {
  message: string;
  label?: string;
  initial_agent?: string;
  task_name?: string;
  branch_type?: string;
  task_class?: TaskClass;
  task_type?: TaskType;
  trust_mode?: TrustMode;
  use_worktree?: boolean;
  max_hops?: number;
  timeout_ms?: number;
  project_id?: string;
  parent_handoff_id?: string;
  branch_base?: string;
  isolated_install?: boolean;
  tool_free?: boolean;
  permission_profile?: PermissionProfile;
};

export type FanoutDefaults = Omit<FanoutTask, "message" | "label">;

export type FanoutOptions = {
  tasks: readonly FanoutTask[];
  defaults: FanoutDefaults;
  retryBackoffMs?: number;
};

export type FanoutCtx = WorkflowCtx & {
  chainStart?: (input: ChainStartRequest) => Promise<Response> | Response;
};

export type FanoutTaskResult = CancelOutcome & {
  ok: boolean;
  status: "completed" | "failed" | "timeout" | "error";
  label: string;
  index: number;
  initial_agent: string;
  conversation_id: string | null;
  handoff_id: string | null;
  root_handoff_id: string | null;
  latest_handoff_id: string | null;
  hop_count: number | null;
  extra_hops: number | null;
  retry_prompt_count: number | null;
  hops_incomplete: boolean | null;
  hops: FanoutHop[] | null;
  branch_name: string | null;
  branch_base: string | null;
  parent_handoff_id: string | null;
  response_text: string | null;
  final_agent: string | null;
  reliability_status: DispatchReliabilityStatus | null;
  reliability_trustworthy: boolean | null;
  reliability_action: DispatchRecommendedAction | null;
  latest_reliability_status: DispatchReliabilityStatus | null;
  latest_reliability_trustworthy: boolean | null;
  latest_reliability_action: DispatchRecommendedAction | null;
  retry_count: number;
  error_code: string | null;
  error_summary: string | null;
};

export type FanoutResult = { ok: boolean; results: FanoutTaskResult[] };

type ResolvedTask = {
  request: ChainStartRequest;
  label: string;
  timeoutMs: number;
};

type StartSuccess = {
  ok: true;
  conversationId: string;
  handoffId: string;
  branchName: string | null;
  retryCount: number;
};

type StartFailure = {
  ok: false;
  retryCount: number;
  errorCode: string | null;
  errorSummary: string;
};

type StartAttempt =
  | { ok: true; conversationId: string; handoffId: string; branchName: string | null }
  | { ok: false; retryable: boolean; errorCode: string | null; errorSummary: string };

function setDefined<K extends keyof ChainStartRequest>(
  request: ChainStartRequest,
  key: K,
  value: ChainStartRequest[K] | undefined,
): void {
  if (value !== undefined) request[key] = value;
}

function resolveTask(
  ctx: FanoutCtx,
  task: FanoutTask,
  defaults: FanoutDefaults,
  index: number,
): ResolvedTask | string {
  const projectId = task.project_id ?? defaults.project_id ?? ctx.project;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    return "project_scope_required";
  }
  const timeoutMs = task.timeout_ms ?? defaults.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return "invalid_timeout_ms";
  const request: ChainStartRequest = {
    initial_agent: task.initial_agent ?? defaults.initial_agent ?? "executor",
    message: task.message,
    project_id: projectId,
    dispatch_kind: "workflow",
  };
  setDefined(request, "task_name", task.task_name ?? task.label ?? defaults.task_name);
  setDefined(request, "branch_type", task.branch_type ?? defaults.branch_type);
  setDefined(request, "task_class", task.task_class ?? defaults.task_class ?? "STANDARD");
  setDefined(request, "task_type", task.task_type ?? defaults.task_type ?? "unknown");
  setDefined(request, "trust_mode", task.trust_mode ?? defaults.trust_mode ?? "all");
  setDefined(request, "use_worktree", task.use_worktree ?? defaults.use_worktree ?? true);
  setDefined(request, "max_hops", task.max_hops ?? defaults.max_hops ?? 8);
  setDefined(request, "parent_handoff_id", task.parent_handoff_id ?? defaults.parent_handoff_id);
  setDefined(request, "branch_base", task.branch_base ?? defaults.branch_base);
  setDefined(request, "isolated_install", task.isolated_install ?? defaults.isolated_install);
  setDefined(request, "tool_free", task.tool_free ?? defaults.tool_free);
  setDefined(request, "permission_profile", task.permission_profile ?? defaults.permission_profile);
  // The workflow's cwd is the originating caller root: persist it so a
  // profiled dispatch's write sandbox denies this repo too.
  request.caller_cwd = ctx.cwd;
  return { request, label: task.label ?? `task-${String(index)}`, timeoutMs };
}

function deadlineRemaining(ctx: FanoutCtx): number | null {
  if (!ctx.deadline) return null;
  const deadline = ctx.deadline();
  if (deadline.expired) return 0;
  return deadline.remaining_ms === null ? null : Math.max(deadline.remaining_ms, 0);
}

function nestedErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function startAttempt(ctx: FanoutCtx, request: ChainStartRequest): Promise<StartAttempt> {
  if (!ctx.chainStart) {
    return {
      ok: false,
      retryable: false,
      errorCode: null,
      errorSummary: "chain_start_unavailable",
    };
  }
  let response: Response;
  try {
    response = await ctx.chainStart(request);
  } catch {
    return { ok: false, retryable: false, errorCode: null, errorSummary: "chain_start_failed" };
  }
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const errorCode = nestedErrorCode(payload);
    return {
      ok: false,
      retryable:
        response.status === 503 && errorCode !== null && WORKER_UNAVAILABLE_CODES.has(errorCode),
      errorCode,
      errorSummary: "chain_start_failed",
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, retryable: false, errorCode: null, errorSummary: "chain_start_malformed" };
  }
  const row = payload as Record<string, unknown>;
  if (typeof row.conversation_id !== "string" || typeof row.handoff_id !== "string") {
    return { ok: false, retryable: false, errorCode: null, errorSummary: "chain_start_malformed" };
  }
  // A profiled dispatch must never proceed when the daemon didn't echo the
  // profile back — an unechoed profile means the row was persisted unprofiled
  // and Layer A/B enforcement is absent.
  if (
    request.permission_profile !== undefined &&
    row.permission_profile !== request.permission_profile
  ) {
    return {
      ok: false,
      retryable: false,
      errorCode: "permission_profile_echo_mismatch",
      errorSummary: `requested ${request.permission_profile} but chain_start echoed ${JSON.stringify(row.permission_profile)}`,
    };
  }
  return {
    ok: true,
    conversationId: row.conversation_id,
    handoffId: row.handoff_id,
    branchName: typeof row.branch_name === "string" ? row.branch_name : null,
  };
}

async function waitForRetryBackoff(ctx: FanoutCtx, backoffMs: number): Promise<boolean> {
  const remaining = deadlineRemaining(ctx);
  if (remaining !== null && remaining <= backoffMs) return false;
  if (backoffMs > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, backoffMs);
    });
  }
  const after = deadlineRemaining(ctx);
  return after === null || after > 0;
}

async function startWithRetry(
  ctx: FanoutCtx,
  request: ChainStartRequest,
  retryBackoffMs: number,
): Promise<StartSuccess | StartFailure> {
  let retryCount = 0;
  for (;;) {
    const remaining = deadlineRemaining(ctx);
    if (remaining !== null && remaining <= 0) {
      return { ok: false, retryCount, errorCode: null, errorSummary: "run_deadline_expired" };
    }
    const attempt = await startAttempt(ctx, request);
    if (attempt.ok) return { ...attempt, retryCount };
    if (!attempt.retryable || retryCount >= MAX_WORKER_UNAVAILABLE_RETRIES) {
      return {
        ok: false,
        retryCount,
        errorCode: attempt.errorCode,
        errorSummary: attempt.errorSummary,
      };
    }
    if (!(await waitForRetryBackoff(ctx, retryBackoffMs))) {
      return {
        ok: false,
        retryCount,
        errorCode: attempt.errorCode,
        errorSummary: "run_deadline_expired",
      };
    }
    retryCount += 1;
  }
}

function failedBeforeStart(
  label: string,
  index: number,
  initialAgent: string,
  errorSummary: string,
  retryCount = 0,
  errorCode: string | null = null,
): FanoutTaskResult {
  return {
    ok: false,
    status: "error",
    label,
    index,
    initial_agent: initialAgent,
    conversation_id: null,
    handoff_id: null,
    root_handoff_id: null,
    ...unknownFanoutHopEvidence(null),
    response_text: null,
    final_agent: null,
    retry_count: retryCount,
    error_code: errorCode,
    error_summary: errorSummary,
    cancel_requested: false,
  };
}

function readEvidence(ctx: FanoutCtx, started: StartSuccess): FanoutHopEvidence {
  if (!ctx.db) return unknownFanoutHopEvidence(started.branchName);
  try {
    const db = (ctx.db as () => unknown)();
    if (!db || typeof db !== "object") return unknownFanoutHopEvidence(started.branchName);
    return readFanoutHopEvidence(db as Database, {
      conversationId: started.conversationId,
      rootHandoffId: started.handoffId,
      provisionalBranchName: started.branchName,
    });
  } catch {
    return unknownFanoutHopEvidence(started.branchName);
  }
}

function resultError(
  status: FanoutTaskResult["status"],
  responseText: string | null,
  reliability: boolean | null,
  waitError: string | null,
): string | null {
  if (waitError) return waitError;
  if (status === "timeout") return "wait_timeout";
  if (status === "failed") return "chain_failed";
  if (!responseText?.trim()) return "missing_response";
  if (reliability === false) return "reliability_untrustworthy";
  if (reliability !== true) return "reliability_unverified";
  return null;
}

async function waitForTask(
  ctx: FanoutCtx,
  started: StartSuccess,
  timeoutMs: number,
): Promise<
  CancelOutcome & {
    status: FanoutTaskResult["status"];
    finalAgent: string | null;
    responseText: string | null;
    waitError: string | null;
  }
> {
  const remaining = deadlineRemaining(ctx);
  if (remaining !== null && remaining <= 0) {
    // The chain already started; the run giving up on the wait must not leave
    // the dispatch running unwatched.
    const cancel = await cancelChainQuietly(ctx, started.conversationId);
    return {
      ...cancel,
      status: "timeout",
      finalAgent: null,
      responseText: null,
      waitError: "run_deadline_expired",
    };
  }
  const effectiveTimeoutMs = remaining === null ? timeoutMs : Math.min(timeoutMs, remaining);
  const awaited = await awaitChainOrCancel(ctx, started.conversationId, {
    timeoutMs: effectiveTimeoutMs,
  });
  const cancel = { cancel_requested: awaited.cancel_requested, cancel_error: awaited.cancel_error };
  if (awaited.wait === null) {
    return {
      status: "error",
      finalAgent: null,
      responseText: null,
      waitError: "wait_failed",
      ...cancel,
    };
  }
  return {
    ...cancel,
    status: awaited.wait.status,
    finalAgent: awaited.wait.final_agent,
    responseText: awaited.wait.response_text,
    waitError: null,
  };
}

async function runTask(
  ctx: FanoutCtx,
  task: FanoutTask,
  defaults: FanoutDefaults,
  retryBackoffMs: number,
  index: number,
): Promise<FanoutTaskResult> {
  const resolved = resolveTask(ctx, task, defaults, index);
  const label = task.label ?? `task-${String(index)}`;
  const initialAgent = task.initial_agent ?? defaults.initial_agent ?? "executor";
  if (typeof resolved === "string") {
    return failedBeforeStart(label, index, initialAgent, resolved);
  }
  const started = await startWithRetry(ctx, resolved.request, retryBackoffMs);
  if (!started.ok) {
    return failedBeforeStart(
      resolved.label,
      index,
      resolved.request.initial_agent,
      started.errorSummary,
      started.retryCount,
      started.errorCode,
    );
  }
  const waited = await waitForTask(ctx, started, resolved.timeoutMs);
  const evidence = readEvidence(ctx, started);
  const errorSummary = resultError(
    waited.status,
    waited.responseText,
    evidence.reliability_trustworthy,
    waited.waitError,
  );
  return {
    ok: errorSummary === null,
    status: waited.status,
    label: resolved.label,
    index,
    initial_agent: resolved.request.initial_agent,
    conversation_id: started.conversationId,
    handoff_id: started.handoffId,
    root_handoff_id: started.handoffId,
    ...evidence,
    response_text: waited.responseText,
    final_agent: waited.finalAgent,
    retry_count: started.retryCount,
    error_code: null,
    error_summary: errorSummary,
    cancel_requested: waited.cancel_requested,
    ...(waited.cancel_error !== undefined ? { cancel_error: waited.cancel_error } : {}),
  };
}

export async function runFanout(ctx: FanoutCtx, options: FanoutOptions): Promise<FanoutResult> {
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const results = await Promise.all(
    options.tasks.map((task, index) => runTask(ctx, task, options.defaults, retryBackoffMs, index)),
  );
  return { ok: results.length > 0 && results.every((result) => result.ok), results };
}
