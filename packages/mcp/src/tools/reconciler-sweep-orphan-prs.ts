import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ReconcilerSweepOrphanPrsInputShape = {
  dry_run: z.boolean().optional().describe('Override dry-run mode for this manual sweep.'),
  max_close: z.number().int().positive().optional().describe('Optional cap on how many PRs to act on in this run.'),
};

export function reconcilerSweepOrphanPrsHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const res = await daemon.reconcilerSweepOrphanPrs({
      dry_run: input?.dry_run,
      max_close: input?.max_close,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res) }],
    };
  };
}
