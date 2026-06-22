import type { AgentChatConfig } from "../config/types.js";

export type Resolution =
  | { kind: "role"; agent_name: string; role: string }
  | { kind: "name"; agent_name: string }
  | { kind: "unknown"; target: string };

export function resolveMention(target: string, cfg: AgentChatConfig): Resolution {
  const roleBinding = cfg.default_roles?.[target];
  if (roleBinding) {
    const exists = cfg.agents.some((a) => a.name === roleBinding);
    if (exists) return { kind: "role", agent_name: roleBinding, role: target };
  }
  const named = cfg.agents.find((a) => a.name === target);
  if (named) return { kind: "name", agent_name: named.name };
  return { kind: "unknown", target };
}
