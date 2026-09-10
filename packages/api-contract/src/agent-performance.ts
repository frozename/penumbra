import { z } from "zod";

export const AgentTaskTypeSchema = z.enum([
  "plan_refine",
  "implement_small",
  "implement_substantial",
  "review_adversarial",
  "docs_mechanical",
  "debug_diagnose",
  "smoke_test",
  "health_check",
  "unknown",
]);

export type AgentTaskType = z.infer<typeof AgentTaskTypeSchema>;
