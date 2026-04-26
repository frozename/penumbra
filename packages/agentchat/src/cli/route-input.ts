import type { AgentChatConfig } from '../config/types.js';
import { parseMentions } from '../mention/parser.js';
import { resolveMention } from '../mention/resolver.js';

export function resolveInitialAgent(userMessage: string, config: AgentChatConfig): string {
  const knownTargets = [...config.agents.map(a => a.name), ...Object.keys(config.default_roles)];
  const mentions = parseMentions(userMessage, { knownTargets });
  if (mentions.length > 0) {
    const r = resolveMention(mentions[0]!.target, config);
    if (r.kind === 'role' || r.kind === 'name') return r.agent_name;
  }
  return config.default_roles.planner ?? '';
}
