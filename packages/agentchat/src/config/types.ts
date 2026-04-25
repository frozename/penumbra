// packages/agentchat/src/config/types.ts
import { z } from 'zod';

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  adapter: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
  roles: z.array(z.string().min(1)).default([]),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentChatConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1),
  default_roles: z.record(z.string(), z.string()).default({}),
});
export type AgentChatConfig = z.infer<typeof AgentChatConfigSchema>;
