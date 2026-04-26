import { buildAdapter } from '../adapters/registry.js';
import { parseMentions, type Mention } from '../mention/parser.js';
import { resolveMention, type Resolution } from '../mention/resolver.js';
import type { AgentChatConfig } from '../config/types.js';

export interface ChatTurnInput {
  config: AgentChatConfig;
  initialAgent: string;
  userMessage: string;
  conversation: { id: string; project_id: string | null };
  /** optional: override prompt assembly. If absent, the userMessage is sent verbatim. */
  prompt?: string;
  observe: (event: any) => Promise<{ event_id: string }>;
}

export interface ChatTurnResult {
  text: string;
  prompt_event_id: string;
  response_event_id: string;
  next_mention: { target: string; resolution: Resolution } | null;
  /** raw mentions found in the response, in order */
  mentions: Mention[];
  /** Set when the adapter dispatch threw. The error response is still observed in t0; the bin should not queue a handoff and should surface the error inline. */
  error?: { message: string };
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const cfg = input.config.agents.find((a) => a.name === input.initialAgent);
  if (!cfg) throw new Error(`agent not found in config: ${input.initialAgent}`);

  const promptText = input.prompt ?? input.userMessage;
  const promptEvent = await input.observe({
    ts: new Date().toISOString(),
    source: 'agentchat',
    event_type: 'agent-prompt',
    lane: 'cli-subscription',
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    user_id: 'local-user',
    machine_id: 'local',
    payload_json: { prompt: promptText },
    payload_summary: promptText.slice(0, 240),
  });

  const adapter = buildAdapter(cfg.adapter, cfg.options);

  let outText = '';
  let dispatchError: { message: string } | undefined;
  try {
    const out = await adapter.dispatch({
      prompt: promptText,
      conversation: input.conversation,
      config: {},
      signal: new AbortController().signal,
    });
    outText = out.text;
  } catch (err) {
    dispatchError = { message: err instanceof Error ? err.message : String(err) };
  }

  const responsePayload = dispatchError
    ? { error: dispatchError.message }
    : { response: outText };
  const responseSummary = dispatchError
    ? `error: ${dispatchError.message}`.slice(0, 240)
    : outText.slice(0, 240);

  const responseEvent = await input.observe({
    ts: new Date().toISOString(),
    source: 'agentchat',
    event_type: 'agent-response',
    lane: 'cli-subscription',
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    user_id: cfg.name,
    machine_id: 'local',
    payload_json: responsePayload,
    payload_summary: responseSummary,
    triggered_by_event_id: promptEvent.event_id,
  });

  // Don't parse mentions on an errored turn — the response text is empty/garbage.
  const knownTargets = [...input.config.agents.map((a) => a.name), ...Object.keys(input.config.default_roles)];
  const mentions = dispatchError ? [] : parseMentions(outText, { knownTargets });
  const next = mentions[0]
    ? { target: mentions[0].target, resolution: resolveMention(mentions[0].target, input.config) }
    : null;

  return {
    text: outText,
    prompt_event_id: promptEvent.event_id,
    response_event_id: responseEvent.event_id,
    next_mention: next,
    mentions,
    ...(dispatchError ? { error: dispatchError } : {}),
  };
}