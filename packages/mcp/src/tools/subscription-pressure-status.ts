import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const SubscriptionPressureStatusInputSchema = z.object({
  provider: z.string().min(1).optional(),
  stale_after_seconds: z.number().int().positive().max(86400).optional(),
});

export const SubscriptionPressureStatusInputShape = SubscriptionPressureStatusInputSchema.shape;

export type SubscriptionPressureStatusInput = z.infer<typeof SubscriptionPressureStatusInputSchema>;

export function subscriptionPressureStatusHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = SubscriptionPressureStatusInputSchema.parse(input ?? {});
    const out = await daemon.subscriptionPressureStatus(parsed);
    return toTextContent(out);
  };
}
