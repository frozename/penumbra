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
  const out = await adapter.dispatch({
    prompt: promptText,
    conversation: input.conversation,
    config: {},
    signal: new AbortController().signal,
  });

  const responseEvent = await input.observe({
    ts: new Date().toISOString(),
    source: 'agentchat',
    event_type: 'agent-response',
    lane: 'cli-subscription',
    session_id: input.conversation.id,
    project_id: input.conversation.project_id,
    user_id: cfg.name,
    machine_id: 'local',
    payload_json: { response: out.text },
    payload_summary: out.text.slice(0, 240),
    triggered_by_event_id: promptEvent.event_id,
  });

  const knownTargets = [...input.config.agents.map((a) => a.name), ...Object.keys(input.config.default_roles)];
  const mentions = parseMentions(out.text, { knownTargets });
  const next = mentions[0]
    ? { target: mentions[0].target, resolution: resolveMention(mentions[0].target, input.config) }
    : null;
  return { 
    text: out.text, 
    prompt_event_id: promptEvent.event_id,
    response_event_id: responseEvent.event_id,
    next_mention: next, 
    mentions 
  };
}