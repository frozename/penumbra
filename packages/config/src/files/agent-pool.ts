import { z } from "zod";

export const AgentPoolMemberSchema = z
  .object({
    agent: z.string().min(1),
    tier: z.enum(["local", "cloud"]).optional(),
  })
  .strict();

export const AgentPoolSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z
    .object({
      members: z.array(AgentPoolMemberSchema).min(1),
      select: z.enum(["rank", "round_robin", "order"]).default("rank"),
      fallback_to_cloud: z.boolean().default(true),
    })
    .strict(),
]);

export const AgentPinSchema = AgentPoolSchema;

export type AgentPoolMember = z.infer<typeof AgentPoolMemberSchema>;
export type AgentPool = z.infer<typeof AgentPoolSchema>;
