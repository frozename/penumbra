import { z } from "zod";

export const WORKLOADS = [
  "plan_refine",
  "implement_small",
  "implement_substantial",
  "review_adversarial",
  "docs_mechanical",
  "debug_diagnose",
  "smoke_test",
  "health_check",
  "unknown",
] as const;

export const WorkloadSchema = z
  .object({
    eligible_roles: z.array(z.string().min(1)).min(1),
    eligible_agents: z.array(z.string().min(1)).min(1).optional(),
    fan_out: z.number().int().positive().optional(),
    synthesizer: z.string().min(1).optional(),
  })
  .strict();

export type Workload = z.infer<typeof WorkloadSchema>;
