import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const AgentRouteForInputSchema = z.object({
  role: z.string().min(1),
  risk_class: z.string().min(1).optional(),
  window_days: z.coerce.number().int().positive().optional(),
  min_samples: z.coerce.number().int().positive().optional(),
  agent_kind: z.enum(['coding', 'long_lived']).optional(),
});

export const AgentRouteForInputShape = AgentRouteForInputSchema.shape;

export function agentRouteForHandler(daemon: Pick<DaemonClient, 'agentRouteFor'>) {
  return async (input: unknown) => {
    const parsed = AgentRouteForInputSchema.parse(input ?? {});
    const out = await daemon.agentRouteFor({
      role: parsed.role,
      risk_class: parsed.risk_class,
      window_days: parsed.window_days,
      min_samples: parsed.min_samples,
      agent_kind: parsed.agent_kind,
    });
    return toTextContent(out);
  };
}
