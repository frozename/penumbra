import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

/**
 * P7 actions restore the prior embedding vector. Other phases stamp reverted_by as a bookkeeping marker only (no automatic state rollback).
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
