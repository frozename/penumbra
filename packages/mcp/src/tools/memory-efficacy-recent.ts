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
  include_raw: {
    type: 'boolean' as const,
    description: 'Include raw_response_json for each recent entry',
  },
};

export function memoryEfficacyRecentHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const args = input as { since?: string; limit?: number; include_raw?: boolean } | undefined;
    return toTextContent(
      await daemon.memoryEfficacyRecent({ since: args?.since, limit: args?.limit, include_raw: args?.include_raw }),
    );
  };
}
