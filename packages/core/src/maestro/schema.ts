import { z } from 'zod';

export const MaestroTerminationReason = z.enum([
  'completed',
  'failed',
  'bounds_exceeded:wall_clock',
  'bounds_exceeded:cost',
  'bounds_exceeded:sub_dispatches',
  'cancelled',
  'daemon_restart',
]);
export type MaestroTerminationReason = z.infer<typeof MaestroTerminationReason>;

export const BoundsAxis = z.enum(['wall_clock', 'cost', 'sub_dispatches']);
export type BoundsAxis = z.infer<typeof BoundsAxis>;

export const MaestroSessionRecord = z.object({
  task_id: z.string(),
  chain_handoff_id: z.string(),
  agent_id: z.string(),
  started_at: z.number().int(),
  wall_clock_budget_ms: z.number().int(),
  cost_budget_cents: z.number().int(),
  sub_dispatch_budget: z.number().int(),
  cost_consumed_cents: z.number().int(),
  sub_dispatches_consumed: z.number().int(),
  soft_warned_at: z.number().int().nullable(),
  terminated_at: z.number().int().nullable(),
  termination_reason: MaestroTerminationReason.nullable(),
});
export type MaestroSessionRecord = z.infer<typeof MaestroSessionRecord>;

export type BoundsConsumed = {
  wall_clock_ms: number;
  cost_cents: number;
  sub_dispatches: number;
  pct: number;
  axis_breakdown: Record<BoundsAxis, number>;
};
