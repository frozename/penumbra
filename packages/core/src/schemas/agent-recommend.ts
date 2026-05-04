import { z } from 'zod';

export const AgentRecommendInputSchema = z.object({
  task_type: z.string().min(1),
  risk_class: z.string().min(1).optional(),
  window_days: z.coerce.number().int().positive().optional(),
});

export type AgentRecommendInput = z.infer<typeof AgentRecommendInputSchema>;
