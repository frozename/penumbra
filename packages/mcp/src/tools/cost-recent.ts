import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const CostRecentInputSchema = z.object({
  since: z.string().datetime().optional(),
  project_id: z.string().min(1).nullable().optional(),
});

export const CostRecentInputShape = CostRecentInputSchema.shape;

export type CostRecentInput = z.infer<typeof CostRecentInputSchema>;

export function costRecentHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = CostRecentInputSchema.parse(input ?? {});
    const out = await daemon.costRecent({ since: parsed.since, project_id: parsed.project_id ?? null });
    return toTextContent(out);
  };
}
