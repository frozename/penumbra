import type { AgentChatConfig } from "../config/types.js";
import type { WriteToolsExecutor } from "../worker/write-tools-executor.js";
import type { ChatTurnInput, ChatTurnResult } from "./loop.js";

import { detectQuotaExhaustion } from "../adapters/cli-spawn.js";
import { classifierDeclineMetaFromUnknown } from "../classifier-decline.js";
import { isTerminalHttpStatus, PenumbraHttpError } from "../penumbra-client.js";
import { runChatTurn as realRunChatTurn } from "./loop.js";
import { buildNextPrompt } from "./transcript.js";
import { isAutoApproved } from "./trust.js";

interface CreateHandoffBody {
  from: string;
  to: string;
  to_role?: string | null;
  message: string;
  conversation_id: string;
  project_id?: string | null;
  triggered_by_event_id: string;
  use_worktree?: boolean | number | null;
  chain_task_type?: string | null;
  parent_handoff_id?: string | null;
  branch_base?: string | null;
  chain_max_hops?: number | null;
}

interface CreateHandoffResult {
  handoff_id: string;
  status: string;
  routed_agent?: string;
  routed_role?: string;
  routing_task_type?: string;
}

interface ApproveBody {
  resolved_by?: string;
  redirect_to?: string;
  reject?: boolean;
  reason?: string;
}

interface ApproveResult {
  handoff_id: string;
  status: string;
}

export interface DispatchHandoffOpts {
  handoff: {
    handoff_id?: string;
    from_agent: string;
    to_agent: string;
    message: string;
    project_id?: string | null;
    use_worktree?: boolean | number | null;
    chain_task_type?: string | null;
    branch_base?: string | null;
    dispatch_kind?: string | null;
    long_lived_agent_id?: string | null;
    long_lived_tick_id?: string | null;
    permission_profile?: ChatTurnInput["permission_profile"];
  };
  config: AgentChatConfig;
  conversation: { id: string; project_id: string | null };
  transcript: { agent: string; text: string }[];
  transcriptBudget: number;
  hopsSoFar: number;
  maxHops: number;
  trustMode: "all" | "config";
  projectContext?: string;
  executor?: WriteToolsExecutor;
  observe: (event: Record<string, unknown>) => Promise<{ event_id: string }>;
  createHandoff: (body: CreateHandoffBody) => Promise<CreateHandoffResult>;
  approve: (id: string, body: ApproveBody) => Promise<ApproveResult>;
  markFailed?: (
    handoff_id: string,
    reason: string,
  ) => Promise<{ handoff_id: string; status: string }>;
  runChatTurn?: (input: ChatTurnInput) => Promise<ChatTurnResult>;
  /**
   * Worker-computed mutable roots for the Layer B sandbox when the handoff is
   * profiled (caller cwd, project root, worktree fleet base). Forwarded onto
   * DispatchInput so every spawn surface shares one deny set.
   */
  sandboxDenyRoots?: readonly string[];
  requestPermission?: ChatTurnInput["requestPermission"];
  eventContext?: ChatTurnInput["eventContext"];
  onEvent?: ChatTurnInput["onEvent"];
  onChunk?: (delta: string) => void;
  log?: { error: (obj: Record<string, unknown>, msg: string) => void };
  /** optional: override retry sleep (tests). */
  delay?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface DispatchTerminalError {
  status: number;
  code?: string;
  message: string;
}

export interface DispatchHandoffResult {
  /** The newly-created next handoff (created+approved) when the chain continues. Null on terminal cases. */
  next: {
    handoff_id: string;
    from: string;
    to: string;
    message: string;
    response_event_id: string;
  } | null;
  /** Set when this hop was the last. Absent if next is non-null. */
  terminatedReason?:
    | "no_mention"
    | "untrusted"
    | "max_hops"
    | "error"
    | "handoff_creation_failed"
    | "cancelled";
  /** The handoff id that was created but not approved (untrusted | max_hops), or the handoff id that failed (error). */
  cappedHandoffId?: string;
  /** Final accumulated reply text from this hop (for transcript building by the caller). */
  text: string;
  /** The dispatching agent for this hop (handoff.to_agent). */
  agent: string;
  /** Non-fatal terminal error from setting up the next hop after this hop completed. */
  terminalError?: DispatchTerminalError;
  /** Adapter/model error that exhausted the retry budget. Tracked separately so
   *  a later transport error cannot overwrite the reason the turn failed. */
  adapterError?: { message: string };
  /** Post-adapter observe envelopes that could not be delivered inline. */
  pendingObservations?: Record<string, unknown>[];
  meta?: ChatTurnResult["meta"];
}

export function pendingObservationsOf(err: unknown): Record<string, unknown>[] {
  if (err && typeof err === "object" && "pendingObservations" in err) {
    const pending = (err as { pendingObservations?: unknown }).pendingObservations;
    if (Array.isArray(pending)) return pending as Record<string, unknown>[];
  }
  return [];
}

export function attachPendingObservations(
  err: unknown,
  pending: Record<string, unknown>[] | undefined,
): unknown {
  if (pending && pending.length > 0 && err instanceof Error) {
    (err as Error & { pendingObservations?: Record<string, unknown>[] }).pendingObservations =
      pending;
  }
  return err;
}

const RETRY_BACKOFF_MS = [200, 400, 800] as const;

async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function extractTurnErrorMessage(turn: ChatTurnResult): string | null {
  return turn.error ? turn.error.message : null;
}

interface TurnAttempt {
  turn: ChatTurnResult | null;
  errMsg: string | null;
  errMeta?: ChatTurnResult["meta"];
  pending?: Record<string, unknown>[];
}

async function runTurnOnce(
  opts: DispatchHandoffOpts,
  targetAgent: string,
  promptText: string | undefined,
): Promise<TurnAttempt> {
  const turnRunner = opts.runChatTurn ?? realRunChatTurn;
  try {
    const turn = await turnRunner({
      config: opts.config,
      initialAgent: targetAgent,
      userMessage: opts.handoff.message,
      conversation: opts.conversation,
      prompt: promptText,
      handoff_id: opts.handoff.handoff_id,
      observe: opts.observe,
      onChunk: opts.onChunk,
      requestPermission: opts.requestPermission,
      trust_mode: opts.trustMode,
      permission_profile: opts.handoff.permission_profile,
      sandbox_deny_roots: opts.sandboxDenyRoots,
      executor: opts.executor,
      eventContext: opts.eventContext,
      onEvent: opts.onEvent,
      signal: opts.signal,
      long_lived_identity: {
        dispatch_kind: opts.handoff.dispatch_kind,
        long_lived_agent_id: opts.handoff.long_lived_agent_id,
        long_lived_tick_id: opts.handoff.long_lived_tick_id,
      },
    });
    const errMsg = extractTurnErrorMessage(turn);
    const errMeta = turn.meta?.classifier_declined ? turn.meta : undefined;
    return {
      turn,
      errMsg,
      ...(errMeta ? { errMeta } : {}),
      ...(turn.pendingObservations ? { pending: turn.pendingObservations } : {}),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const classifierDecline = classifierDeclineMetaFromUnknown(err);
    const pending = pendingObservationsOf(err);
    return {
      turn: null,
      errMsg,
      ...(classifierDecline ? { errMeta: classifierDecline } : {}),
      ...(pending.length > 0 ? { pending } : {}),
    };
  }
}

function exhaustedErrorResult(
  targetAgent: string,
  handoffId: string | undefined,
  errMsg: string,
  errMeta: ChatTurnResult["meta"] | undefined,
  pending: Record<string, unknown>[],
): DispatchHandoffResult {
  return {
    next: null,
    terminatedReason: "error",
    ...(handoffId ? { cappedHandoffId: handoffId } : {}),
    adapterError: { message: errMsg },
    text: "",
    agent: targetAgent,
    ...(errMeta ? { meta: errMeta } : {}),
    ...(pending.length > 0 ? { pendingObservations: pending } : {}),
  };
}

async function handleRetryExhaustion(
  opts: DispatchHandoffOpts,
  targetAgent: string,
  errMsg: string,
  errMeta: ChatTurnResult["meta"] | undefined,
  pending: Record<string, unknown>[],
): Promise<DispatchHandoffResult | null> {
  const handoffId = opts.handoff.handoff_id;
  if (!opts.markFailed || !handoffId) return null;
  try {
    await opts.markFailed(handoffId, errMsg);
  } catch {
    // markFailed itself failed (daemon outage). Return the error result anyway
    // so the dispatcher's durable reporter owns the terminal report.
  }
  return exhaustedErrorResult(targetAgent, handoffId, errMsg, errMeta, pending);
}

function cancelledRetryResult(
  targetAgent: string,
  errMeta: ChatTurnResult["meta"] | undefined,
): DispatchHandoffResult {
  return {
    next: null,
    terminatedReason: "cancelled",
    text: "",
    agent: targetAgent,
    ...(errMeta ? { meta: errMeta } : {}),
  };
}

interface RetryState {
  lastErrMsg: string;
  lastAdapterErrMsg: string | null;
  lastErrMeta: ChatTurnResult["meta"] | undefined;
}

/** Fold one attempt into retry state. Returns the ok-shape when the turn
 *  finished — even with pendingObservations, since a failed daemon call must
 *  never re-run a completed adapter turn. */
function foldAttempt(
  state: RetryState,
  pending: Record<string, unknown>[],
  result: TurnAttempt,
): { ok: true; turn: ChatTurnResult } | null {
  state.lastErrMeta = result.errMeta ?? state.lastErrMeta;
  if (result.pending) pending.push(...result.pending);
  if (!result.turn || result.errMsg !== null) {
    if (result.turn !== null) state.lastAdapterErrMsg = result.errMsg;
    state.lastErrMsg = result.errMsg ?? state.lastErrMsg;
    return null;
  }
  // `pending` already includes this turn's own pendingObservations (pushed
  // above) plus any carried over from earlier attempts.
  if (pending.length > 0) {
    result.turn = { ...result.turn, pendingObservations: pending };
  }
  return { ok: true, turn: result.turn };
}

/** #298: no further attempt once an attempt failed on a provider quota; the seat stays exhausted until its reset. */
function nextBackoffMs(attempt: number, result: TurnAttempt): number | undefined {
  if (result.errMsg !== null && detectQuotaExhaustion(result.errMsg) !== null) return undefined;
  return RETRY_BACKOFF_MS[attempt];
}

async function runTurnWithRetry(
  opts: DispatchHandoffOpts,
  targetAgent: string,
  promptText: string | undefined,
): Promise<{ ok: true; turn: ChatTurnResult } | { ok: false; result: DispatchHandoffResult }> {
  const delay = opts.delay ?? defaultDelay;
  const state: RetryState = {
    lastErrMsg: "adapter dispatch failed",
    lastAdapterErrMsg: null,
    lastErrMeta: undefined,
  };
  const pending: Record<string, unknown>[] = [];

  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    if (opts.signal?.aborted)
      return { ok: false, result: cancelledRetryResult(targetAgent, state.lastErrMeta) };
    const result = await runTurnOnce(opts, targetAgent, promptText);
    const done = foldAttempt(state, pending, result);
    if (done) return done;
    if (opts.signal?.aborted)
      return { ok: false, result: cancelledRetryResult(targetAgent, state.lastErrMeta) };
    const backoff = nextBackoffMs(attempt, result);
    if (backoff === undefined) break;
    await delay(backoff);
  }

  const failed = await handleRetryExhaustion(
    opts,
    targetAgent,
    state.lastAdapterErrMsg ?? state.lastErrMsg,
    state.lastErrMeta,
    pending,
  );
  if (failed) return { ok: false, result: failed };
  throw attachPendingObservations(new Error(state.lastAdapterErrMsg ?? state.lastErrMsg), pending);
}

function resolveNextHop(turn: ChatTurnResult): { nextTo: string; nextRole: string | null } | null {
  if (!turn.next_mention) return null;
  const resolution = turn.next_mention.resolution;
  if (resolution.kind === "unknown") return null;
  const nextTo = resolution.agent_name;
  const nextRole = resolution.kind === "role" ? resolution.role : null;
  return { nextTo, nextRole };
}

function metaSpread(turn: ChatTurnResult): { meta?: ChatTurnResult["meta"] } {
  return turn.meta ? { meta: turn.meta } : {};
}

function buildPromptText(opts: DispatchHandoffOpts): string | undefined {
  if (opts.handoff.from_agent === "user") return undefined;
  return buildNextPrompt(opts.transcript, opts.handoff.from_agent, opts.handoff.message, {
    maxTokens: opts.transcriptBudget,
    projectContext: opts.projectContext,
  });
}

function pendingSpread(turn: ChatTurnResult): {
  pendingObservations?: Record<string, unknown>[];
} {
  return turn.pendingObservations && turn.pendingObservations.length > 0
    ? { pendingObservations: turn.pendingObservations }
    : {};
}

function terminalResult(
  reason: NonNullable<DispatchHandoffResult["terminatedReason"]>,
  turn: ChatTurnResult,
  targetAgent: string,
  cappedHandoffId?: string,
  terminalError?: DispatchTerminalError,
): DispatchHandoffResult {
  return {
    next: null,
    terminatedReason: reason,
    ...(cappedHandoffId ? { cappedHandoffId } : {}),
    ...(terminalError ? { terminalError } : {}),
    text: turn.text,
    agent: targetAgent,
    ...metaSpread(turn),
    ...pendingSpread(turn),
  };
}

function terminalErrorFromHttp(err: PenumbraHttpError): DispatchTerminalError {
  return {
    status: err.status,
    ...(err.code ? { code: err.code } : {}),
    message: err.message,
  };
}

async function createNextHandoff(
  opts: DispatchHandoffOpts,
  turn: ChatTurnResult,
  targetAgent: string,
  nextHop: { nextTo: string; nextRole: string | null },
): Promise<{ created: CreateHandoffResult } | { result: DispatchHandoffResult }> {
  let created: CreateHandoffResult;
  try {
    created = await opts.createHandoff({
      from: targetAgent,
      to: nextHop.nextTo,
      to_role: nextHop.nextRole,
      message: turn.text,
      conversation_id: opts.conversation.id,
      project_id: opts.conversation.project_id,
      triggered_by_event_id: turn.response_event_id,
      use_worktree: opts.handoff.use_worktree,
      chain_task_type: opts.handoff.chain_task_type,
      parent_handoff_id: opts.handoff.handoff_id,
      branch_base: opts.handoff.branch_base ?? null,
      chain_max_hops: opts.maxHops,
    });
  } catch (err) {
    if (err instanceof PenumbraHttpError && isTerminalHttpStatus(err.status)) {
      const terminalError = terminalErrorFromHttp(err);
      if (err.status === 401 || err.status === 403) {
        opts.log?.error(
          {
            handoff_id: opts.handoff.handoff_id,
            status: err.status,
            code: err.code,
            body: err.body,
          },
          "handoff creation rejected by daemon auth",
        );
      }
      return {
        result: terminalResult(
          "handoff_creation_failed",
          turn,
          targetAgent,
          undefined,
          terminalError,
        ),
      };
    }
    // A retryable failure after the turn finished must still carry the unsent
    // observe envelopes so the dispatcher's terminal report can deliver them.
    throw attachPendingObservations(err, turn.pendingObservations);
  }
  return { created };
}

export async function dispatchHandoff(opts: DispatchHandoffOpts): Promise<DispatchHandoffResult> {
  const targetAgent = opts.handoff.to_agent;
  const promptText = buildPromptText(opts);

  const attempt = await runTurnWithRetry(opts, targetAgent, promptText);
  if (!attempt.ok) return attempt.result;
  const turn = attempt.turn;

  const nextHop = resolveNextHop(turn);
  if (!nextHop) return terminalResult("no_mention", turn, targetAgent);

  // hop cap is checked against hopsSoFar+1 (this hop completed; the next would be hopsSoFar+1)
  if (opts.hopsSoFar + 1 >= opts.maxHops) {
    return terminalResult("max_hops", turn, targetAgent);
  }

  const createRes = await createNextHandoff(opts, turn, targetAgent, nextHop);
  if ("result" in createRes) return createRes.result;
  const created = createRes.created;
  const routedNextTo = created.routed_agent ?? nextHop.nextTo;

  if (opts.trustMode === "config" && !isAutoApproved(opts.config, targetAgent, routedNextTo)) {
    return terminalResult("untrusted", turn, targetAgent, created.handoff_id);
  }

  try {
    await opts.approve(created.handoff_id, { resolved_by: "auto" });
  } catch (err) {
    throw attachPendingObservations(err, turn.pendingObservations);
  }

  return {
    next: {
      handoff_id: created.handoff_id,
      from: targetAgent,
      to: routedNextTo,
      message: turn.text,
      response_event_id: turn.response_event_id,
    },
    text: turn.text,
    agent: targetAgent,
    ...metaSpread(turn),
    ...pendingSpread(turn),
  };
}
