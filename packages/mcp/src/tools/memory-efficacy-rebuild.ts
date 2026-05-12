import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const MemoryEfficacyRebuildInputShape = {
  since: {
    type: 'string' as const,
    description: 'ISO date string to filter synthesis dirs from',
  },
  reviews_dir: {
    type: 'string' as const,
    description: 'Path to reviews directory (default: <repo>/.penumbra/reviews)',
  },
  source: {
    type: 'string' as const,
    description: "Attribution for the job's enqueued_by column. One of maestro | cli | http. Default maestro for MCP callers.",
  },
};

export function memoryEfficacyRebuildHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const args = input as { since?: string; reviews_dir?: string; source?: string } | undefined;
    return toTextContent(
      await daemon.memoryEfficacyRebuild({
        since: args?.since,
        reviews_dir: args?.reviews_dir,
        source: args?.source ?? 'maestro',
      }),
    );
  };
}
