import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const MemoryEfficacyRecentInputShape = {
  since: {
    type: 'string' as const,
    description: 'ISO date string to filter findings from',
  },
  limit: {
    type: 'number' as const,
    description: 'Max recent entries to return (default 20, max 100)',
  },
};

export function memoryEfficacyRecentHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const args = input as { since?: string; limit?: number } | undefined;
    return toTextContent(
      await daemon.memoryEfficacyRecent({ since: args?.since, limit: args?.limit }),
    );
  };
}
