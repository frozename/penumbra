import { MaestroSessionRecord } from '@penumbra/core';
import { toTextContent } from '@nova/mcp-shared';
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const MaestroSessionStartInputSchema = z.object({
  task_id: z.string().min(1),
  chain_handoff_id: z.string().min(1),
  agent_id: z.string().min(1),
  wall_clock_budget_ms: z.number().int().positive(),
  cost_budget_cents: z.number().int().nonnegative(),
  sub_dispatch_budget: z.number().int().nonnegative(),
}).strict();

export const MaestroSessionStartInputShape = MaestroSessionStartInputSchema.shape;

export function maestroSessionStartHandler(daemon: Pick<DaemonClient, 'maestroSessionStart'>) {
  return async (input: unknown) => {
    const parsed = MaestroSessionStartInputSchema.parse(input ?? {});
    const out = await daemon.maestroSessionStart(parsed);
    return toTextContent(MaestroSessionRecord.parse(out));
  };
}
