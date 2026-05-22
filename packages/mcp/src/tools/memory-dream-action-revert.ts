import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

/**
 * Reverts a dream action. P1/P2/P3 retire/P6/P7 roll back the side effects
 * (un-promote, retire link, un-retire memory, delete brief, restore vector).
 * Other phases stamp reverted_by as a bookkeeping marker only.
 */
export const MemoryDreamActionRevertInputShape = z.object({
  action_id: z.string().min(1),
  cascade: z.enum(['none', 'force']).default('none').optional(),
});

export type MemoryDreamActionRevertInput = z.infer<typeof MemoryDreamActionRevertInputShape>;

export function memoryDreamActionRevertHandler(daemon: DaemonClient) {
  return async (args: unknown) => {
    const input = MemoryDreamActionRevertInputShape.parse(args);
    return await daemon.memoryDreamActionRevert(input);
  };
}
