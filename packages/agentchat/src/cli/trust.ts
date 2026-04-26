import type { AgentChatConfig } from '../config/types.js';

export function isAutoApproved(config: AgentChatConfig, sender: string, target: string): boolean {
  const senderCfg = config.agents.find((a) => a.name === sender);
  if (!senderCfg || senderCfg.auto_approve_to.length === 0) return false;
  const whitelist = new Set(senderCfg.auto_approve_to);
  if (whitelist.has(target)) return true;
  const targetCfg = config.agents.find((a) => a.name === target);
  if (!targetCfg) return false;
  return targetCfg.roles.some((role) => whitelist.has(role));
}
