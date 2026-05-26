import { z } from 'zod';
import { WORKLOADS, WorkloadSchema } from './workload.js';

/**
 * Schema for the routing-focused config split file.
 * Covers role defaults, exploration policy, and skill rosters.
 * Keeps routing data separate from agent and quota concerns.
 */

export const RoleRoutingConfigSchema = z
  .object({
    exploration_policy: z.enum(['unsampled-first', 'ranked-first']).default('unsampled-first'),
  })
  .default({ exploration_policy: 'unsampled-first' });
export type RoleRoutingConfig = z.infer<typeof RoleRoutingConfigSchema>;

export const SkillRosterEntrySchema = z.object({
  personas: z.array(z.string().min(1)),
  synthesizer: z.string().min(1),
});
export type SkillRosterEntry = z.infer<typeof SkillRosterEntrySchema>;

export const SkillRostersConfigSchema = z.object({
  review: SkillRosterEntrySchema,
  plan: SkillRosterEntrySchema,
});
export type SkillRostersConfig = z.infer<typeof SkillRostersConfigSchema>;

const workloadShape = Object.fromEntries(
  WORKLOADS.map((workload) => [workload, WorkloadSchema.optional()])
) as {
  [K in (typeof WORKLOADS)[number]]: z.ZodOptional<typeof WorkloadSchema>;
};

export const WorkloadsConfigSchema = z.object(workloadShape).strict();
export type WorkloadsConfig = z.infer<typeof WorkloadsConfigSchema>;

export const RoutingConfigSchema = z
  .object({
    default_roles: z.record(z.string(), z.string()).default({}),
    role_routing: RoleRoutingConfigSchema.optional(),
    skill_rosters: SkillRostersConfigSchema.optional(),
    workloads: WorkloadsConfigSchema.optional(),
  })
  .strict();
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
