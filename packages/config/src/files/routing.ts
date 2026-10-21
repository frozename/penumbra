import { z } from "zod";

import { AgentPinSchema, AgentPoolSchema } from "./agent-pool.js";
import { WORKLOADS, WorkloadSchema } from "./workload.js";

/**
 * Schema for the routing-focused config split file.
 * Covers role defaults, exploration policy, and workloads.
 * Keeps routing data separate from agent and quota concerns.
 */

export const RoleRoutingConfigSchema = z
  .object({
    exploration_policy: z.enum(["unsampled-first", "ranked-first"]).default("unsampled-first"),
    headroom_weighting: z.boolean().optional(),
    latency_weighting: z.boolean().optional(),
    warm_pool_reuse_weighting: z.boolean().optional(),
    // Opt-in: gate local openai-compat seats by live backend health (probe
    // /v1/models). Off by default; when unset, routing is unchanged and the
    // daemon never probes, so penumbra works with no local-model server present.
    local_seat_health_gate: z.boolean().optional(),
  })
  .strict()
  .default({ exploration_policy: "unsampled-first" });
export type RoleRoutingConfig = z.infer<typeof RoleRoutingConfigSchema>;

export { AgentPinSchema, AgentPoolSchema };

export const PersonaSchema = z
  .object({
    preferred_agent: AgentPinSchema,
    bias: z.string().min(1),
    system_prompt: z.string().min(1),
    category_hints: z.array(z.string().min(1)).optional(),
    optional: z.boolean().optional(),
  })
  .strict();
export type PersonaConfig = z.infer<typeof PersonaSchema>;

const workloadShape = Object.fromEntries(
  WORKLOADS.map((workload) => [workload, WorkloadSchema.optional()]),
) as Record<(typeof WORKLOADS)[number], z.ZodOptional<typeof WorkloadSchema>>;

export const WorkloadsConfigSchema = z.object(workloadShape).strict();
export type WorkloadsConfig = z.infer<typeof WorkloadsConfigSchema>;

export const RoutingConfigSchema = z
  .object({
    default_roles: z.record(z.string(), z.string()).default({}),
    role_routing: RoleRoutingConfigSchema.optional(),
    personas: z.record(z.string(), PersonaSchema).optional(),
    workloads: WorkloadsConfigSchema.optional(),
    // Read by the worker's merge reconciler, which merges routing.yaml into its own config; the daemon ignores it.
    reconcilerAutoRebase: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const personas = value.personas ?? {};
    const workloads = value.workloads;
    if (!workloads) return;

    for (const workloadName of ["plan_refine", "review_adversarial"] as const) {
      const workload = workloads[workloadName];
      if (!workload?.eligible_agents) continue;
      for (const [index, personaKey] of workload.eligible_agents.entries()) {
        if (personas[personaKey]) continue;
        ctx.addIssue({
          code: "custom",
          path: ["workloads", workloadName, "eligible_agents", index],
          message: `unknown persona '${personaKey}'; add personas.${personaKey} to routing.yaml`,
        });
      }
    }
  })
  .strict();
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
