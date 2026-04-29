// packages/agentchat/src/config/types.ts
import { z } from 'zod';

export const AgentOptionsSchema = z.looseObject({
  /** Tool name allowlist for chain_trust_mode='config'. Strings without glob chars are exact-matched; strings containing *?[ are matched as picomatch globs. Default: undefined ⇒ treated as []. */
  allowed_tools: z.array(z.string()).optional(),
  /** Override of PENUMBRA_PERMISSION_TTL_S for this agent. Seconds. */
  permission_ttl_s: z.number().int().positive().optional(),
  /** Phase 1b.1: advertise fs.readTextFile capability. */
  fsReadTextFile: z.boolean().optional(),
  /** Phase 1d: advertise fs.writeTextFile capability (ACP wire). */
  fsWriteTextFile: z.boolean().optional(),
  /** Phase 1d: advertise terminal/* capability (ACP wire). */
  terminal: z.boolean().optional(),
  /** Phase 1d: expose write tools via penumbra-mcp. */
  mcpWriteTools: z.boolean().optional(),
  /** Sandbox PATH for terminal commands. Default: '/usr/bin:/bin'. */
  terminal_path: z.string().optional(),
  /** Per-command timeout in seconds. Default: 30. */
  terminal_timeout_s: z.number().int().min(1).max(300).optional(),
  /** Terminal output cap in bytes. Default: 1 MiB. */
  terminal_output_max_bytes: z.number().int().min(1024).max(8388608).optional(),
  /** Max concurrent terminals per dispatch. Default: 3. */
  terminal_max_concurrent: z.number().int().min(1).max(8).optional(),
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

export const ProviderQuotaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  quota_usd_per_24h: z.number().positive().optional(),
  quota_tokens_per_24h: z.number().int().positive().optional(),
  quota_tokens_per_5h: z.number().int().positive().optional(),
});
export type ProviderQuotaConfig = z.infer<typeof ProviderQuotaConfigSchema>;

export const AgentChatConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1),
  default_roles: z.record(z.string(), z.string()).default({}),
  providers: z.array(ProviderQuotaConfigSchema).default([]),
});
export type AgentChatConfig = z.infer<typeof AgentChatConfigSchema>;
