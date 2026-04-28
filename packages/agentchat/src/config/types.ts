// packages/agentchat/src/config/types.ts
import { z } from 'zod';

export const AgentOptionsSchema = z.looseObject({
  /** Tool name allowlist for chain_trust_mode='config'. Strings without glob chars are exact-matched; strings containing *?[ are matched as picomatch globs. Default: undefined ⇒ treated as []. */
  allowed_tools: z.array(z.string()).optional(),
  /** Override of PENUMBRA_PERMISSION_TTL_S for this agent. Seconds. */
  permission_ttl_s: z.number().int().positive().optional(),
});
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  adapter: z.string().min(1),
  options: AgentOptionsSchema.default({}),
  roles: z.array(z.string().min(1)).default([]),
  auto_approve_to: z.array(z.string().min(1)).default([]),
  /** One-line summary of what this agent is and what it's good at. Free text. */
  description: z.string().optional(),
  /** Capability hints for routing decisions: e.g. ["local","gemma4","fast","extraction"]. */
  tags: z.array(z.string().min(1)).optional(),
  /** Empirical observations from past use — pitfalls, strengths, quant-specific notes. Each entry is one short bullet. */
  quirks: z.array(z.string().min(1)).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentChatConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1),
  default_roles: z.record(z.string(), z.string()).default({}),
});
export type AgentChatConfig = z.infer<typeof AgentChatConfigSchema>;
