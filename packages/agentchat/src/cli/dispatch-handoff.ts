import type { AgentChatConfig } from "../config/types.js";
import type { WriteToolsExecutor } from "../worker/write-tools-executor.js";
import type { ChatTurnInput, ChatTurnResult } from "./loop.js";

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
  terminatedReason?: "no_mention" | "untrusted" | "max_hops" | "error" | "handoff_creation_failed";
  /** The handoff id that was created but not approved (untrusted | max_hops), or the handoff id that failed (error). */
  cappedHandoffId?: string;
  /** Final accumulated reply text from this hop (for transcript building by the caller). */
  text: string;
  /** The dispatching agent for this hop (handoff.to_agent). */
  agent: string;
  /** Non-fatal terminal error from setting up the next hop after this hop completed. */
  terminalError?: DispatchTerminalError;
  meta?: ChatTurnResult["meta"];
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
    return { turn, errMsg, ...(errMeta ? { errMeta } : {}) };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const classifierDecline = classifierDeclineMetaFromUnknown(err);
    return { turn: null, errMsg, ...(classifierDecline ? { errMeta: classifierDecline } : {}) };
  }
}

async function handleRetryExhaustion(
  opts: DispatchHandoffOpts,
  targetAgent: string,
  errMsg: string,
  errMeta: ChatTurnResult["meta"] | undefined,
): Promise<DispatchHandoffResult | null> {
  const handoffId = opts.handoff.handoff_id;
  if (!opts.markFailed || !handoffId) return null;
  try {
    await opts.markFailed(handoffId, errMsg);
    return {
      next: null,
      terminatedReason: "error",
      cappedHandoffId: handoffId,
      text: "",
      agent: targetAgent,
      ...(errMeta ? { meta: errMeta } : {}),
    };
  } catch {
    return null;
  }
}

async function runTurnWithRetry(
  opts: DispatchHandoffOpts,
  targetAgent: string,
  promptText: string | undefined,
): Promise<{ ok: true; turn: ChatTurnResult } | { ok: false; result: DispatchHandoffResult }> {
  const delay = opts.delay ?? defaultDelay;
  let lastErrMsg = "adapter dispatch failed";
  let lastErrMeta: ChatTurnResult["meta"] | undefined;

  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    const result = await runTurnOnce(opts, targetAgent, promptText);
    if (result.errMeta) lastErrMeta = result.errMeta;
    if (result.turn && !result.errMsg) return { ok: true, turn: result.turn };
    lastErrMsg = result.errMsg ?? lastErrMsg;
    const backoff = RETRY_BACKOFF_MS[attempt];
    if (backoff === undefined) break;
    await delay(backoff);
  }

  const failed = await handleRetryExhaustion(opts, targetAgent, lastErrMsg, lastErrMeta);
  if (failed) return { ok: false, result: failed };
  throw new Error(lastErrMsg);
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
  };
}

function terminalErrorFromHttp(err: PenumbraHttpError): DispatchTerminalError {
  return {
    status: err.status,
    ...(err.code ? { code: err.code } : {}),
    message: err.message,
  };
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
      return terminalResult("handoff_creation_failed", turn, targetAgent, undefined, terminalError);
    }
    throw err;
  }
  const routedNextTo = created.routed_agent ?? nextHop.nextTo;

  if (opts.trustMode === "config" && !isAutoApproved(opts.config, targetAgent, routedNextTo)) {
    return terminalResult("untrusted", turn, targetAgent, created.handoff_id);
  }

  await opts.approve(created.handoff_id, { resolved_by: "auto" });

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
  };
}
