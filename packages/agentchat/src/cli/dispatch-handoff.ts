import type { AgentChatConfig } from '../config/types.js';
import type { ChatTurnInput, ChatTurnResult } from './loop.js';
import { runChatTurn as realRunChatTurn } from './loop.js';
import { buildNextPrompt } from './transcript.js';
import { isAutoApproved } from './trust.js';

export interface DispatchHandoffOpts {
  handoff: { handoff_id?: string; from_agent: string; to_agent: string; message: string };
  config: AgentChatConfig;
  conversation: { id: string; project_id: string | null };
  transcript: { agent: string; text: string }[];
  transcriptBudget: number;
  hopsSoFar: number;
  maxHops: number;
  trustMode: 'all' | 'config';
  projectContext?: string;
  observe: (event: any) => Promise<{ event_id: string }>;
  createHandoff: (body: any) => Promise<{ handoff_id: string; status: string }>;
  approve: (id: string, body: any) => Promise<{ handoff_id: string; status: string }>;
  markFailed?: (handoff_id: string, reason: string) => Promise<{ handoff_id: string; status: string }>;
  runChatTurn?: (input: ChatTurnInput) => Promise<ChatTurnResult>;
  onChunk?: (delta: string) => void;
  /** optional: override retry sleep (tests). */
  delay?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface DispatchHandoffResult {
  /** The newly-created next handoff (created+approved) when the chain continues. Null on terminal cases. */
  next: { handoff_id: string; from: string; to: string; message: string; response_event_id: string } | null;
  /** Set when this hop was the last (no_mention | untrusted | max_hops | error). Absent if next is non-null. */
  terminatedReason?: 'no_mention' | 'untrusted' | 'max_hops' | 'error';
  /** The handoff id that was created but not approved (untrusted | max_hops), or the handoff id that failed (error). */
  cappedHandoffId?: string;
  /** Final accumulated reply text from this hop (for transcript building by the caller). */
  text: string;
  /** The dispatching agent for this hop (handoff.to_agent). */
  agent: string;
}

const RETRY_BACKOFF_MS = [200, 400, 800] as const;
async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
function extractTurnErrorMessage(turn: ChatTurnResult): string | null {
  const err: any = (turn as any).error;
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}

export async function dispatchHandoff(opts: DispatchHandoffOpts): Promise<DispatchHandoffResult> {
  const turnRunner = opts.runChatTurn ?? realRunChatTurn;
  const targetAgent = opts.handoff.to_agent;

  const isChainStart = opts.handoff.from_agent === 'user';
  const promptText = isChainStart
    ? undefined
    : buildNextPrompt(opts.transcript, opts.handoff.from_agent, opts.handoff.message, {
        maxTokens: opts.transcriptBudget,
        projectContext: opts.projectContext,
      });

  const delay = opts.delay ?? defaultDelay;
  let lastErrMsg: string | null = null;
  let turn: ChatTurnResult | null = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      turn = await turnRunner({
        config: opts.config,
        initialAgent: targetAgent,
        userMessage: opts.handoff.message,
        conversation: opts.conversation,
        prompt: promptText,
        observe: opts.observe,
        onChunk: opts.onChunk,
      });
      lastErrMsg = extractTurnErrorMessage(turn);
      if (!lastErrMsg) break;
    } catch (err) {
      lastErrMsg = err instanceof Error ? err.message : String(err);
    }

    // Exhausted retries: mark failed (best-effort). If we have a persisted handoff
    // row and a markFailed hook, treat this as a terminal hop rather than a crash.
    if (attempt === RETRY_BACKOFF_MS.length) {
      if (opts.markFailed && opts.handoff.handoff_id) {
        const reason = lastErrMsg ?? 'adapter dispatch failed';
        try {
          await opts.markFailed(opts.handoff.handoff_id, reason);
          return {
            next: null,
            terminatedReason: 'error',
            cappedHandoffId: opts.handoff.handoff_id,
            text: '',
            agent: targetAgent,
          };
        } catch {
          // Fall through: surface the error if we couldn't mark the row failed.
        }
      }
      throw new Error(lastErrMsg ?? 'adapter dispatch failed');
    }

    await delay(RETRY_BACKOFF_MS[attempt]!);
  }

  // Should be impossible: loop always assigns `turn` before breaking.
  if (!turn) throw new Error(lastErrMsg ?? 'adapter dispatch failed');
  if (!turn.next_mention) {
    return { next: null, terminatedReason: 'no_mention', text: turn.text, agent: targetAgent };
  }

  const nextTo = turn.next_mention.resolution.kind === 'unknown'
    ? turn.next_mention.target
    : (turn.next_mention.resolution as any).agent_name;
  const nextRole = turn.next_mention.resolution.kind === 'role'
    ? (turn.next_mention.resolution as any).role
    : null;

  const created = await opts.createHandoff({
    from: targetAgent,
    to: nextTo,
    to_role: nextRole,
    message: turn.text,
    conversation_id: opts.conversation.id,
    project_id: opts.conversation.project_id,
    triggered_by_event_id: turn.response_event_id,
  });

  // hop cap is checked against hopsSoFar+1 (this hop completed; the next would be hopsSoFar+1)
  if (opts.hopsSoFar + 1 >= opts.maxHops) {
    return {
      next: null, terminatedReason: 'max_hops', cappedHandoffId: created.handoff_id,
      text: turn.text, agent: targetAgent,
    };
  }

  if (opts.trustMode === 'config' && !isAutoApproved(opts.config, targetAgent, nextTo)) {
    return {
      next: null, terminatedReason: 'untrusted', cappedHandoffId: created.handoff_id,
      text: turn.text, agent: targetAgent,
    };
  }

  await opts.approve(created.handoff_id, { resolved_by: 'auto' });

  return {
    next: {
      handoff_id: created.handoff_id, from: targetAgent, to: nextTo,
      message: turn.text, response_event_id: turn.response_event_id,
    },
    text: turn.text, agent: targetAgent,
  };
}
