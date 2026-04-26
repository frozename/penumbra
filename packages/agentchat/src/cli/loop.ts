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
}

export interface ChatTurnResult {
  text: string;
  next_mention: { target: string; resolution: Resolution } | null;
  /** raw mentions found in the response, in order */
  mentions: Mention[];
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const cfg = input.config.agents.find((a) => a.name === input.initialAgent);
  if (!cfg) throw new Error(`agent not found in config: ${input.initialAgent}`);
  const adapter = buildAdapter(cfg.adapter, cfg.options);
  const out = await adapter.dispatch({
    prompt: input.prompt ?? input.userMessage,
    conversation: input.conversation,
    config: {},
    signal: new AbortController().signal,
  });
  const mentions = parseMentions(out.text);
  const next = mentions[0]
    ? { target: mentions[0].target, resolution: resolveMention(mentions[0].target, input.config) }
    : null;
  return { text: out.text, next_mention: next, mentions };
}
