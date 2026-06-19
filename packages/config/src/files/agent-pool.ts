import { z } from "zod";

const AgentNameSchema = z.string().min(1).max(256);

export const AgentPoolMemberSchema = z
  .object({
    agent: AgentNameSchema,
    tier: z.enum(["local", "cloud"]).optional(),
  })
  .strict();

export const AgentPoolSchema = z.union([
  AgentNameSchema,
  z.array(AgentNameSchema).min(1),
  z
    .object({
      members: z.array(AgentPoolMemberSchema).min(1),
      select: z.enum(["rank", "order"]).default("order"),
      fallback_to_cloud: z.boolean().default(true),
    })
    .strict(),
]);

// Back-compat alias; prefer AgentPoolSchema for new code.
export const AgentPinSchema = AgentPoolSchema;

export type AgentPoolMember = z.infer<typeof AgentPoolMemberSchema>;
// Input shape (select / fallback_to_cloud optional before Zod defaults); resolveAgentPool
// normalizes these internally, so consumers may pass an unnormalized pool literal.
export type AgentPool = z.input<typeof AgentPoolSchema>;
