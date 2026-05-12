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
};

export function memoryEfficacyRebuildHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const args = input as { since?: string; reviews_dir?: string } | undefined;
    return toTextContent(
      await daemon.memoryEfficacyRebuild({ since: args?.since, reviews_dir: args?.reviews_dir }),
    );
  };
}
