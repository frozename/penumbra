import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const MemoryEfficacyRebuildInputShape = {
  since: z.string().optional().describe('ISO date string to filter synthesis dirs from'),
  reviews_dir: z.string().optional().describe('Path to reviews directory (default: <repo>/.penumbra/reviews)'),
  source: z.string().optional().describe("Attribution for the job's enqueued_by column. One of maestro | cli | http. Default maestro for MCP callers."),
};

const MemoryEfficacyRebuildSchema = z.object(MemoryEfficacyRebuildInputShape).strict();

export function memoryEfficacyRebuildHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = MemoryEfficacyRebuildSchema.parse(input);
    return toTextContent(await daemon.memoryEfficacyRebuild({ ...parsed, source: parsed.source ?? 'maestro' }));
  };
}
