import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const QualityStatusInputShape = {
  window_hours: {
    type: 'number' as const,
    description: 'Hours of history to include (default 24, max 168)',
  },
  min_samples: {
    type: 'number' as const,
    description: 'Minimum samples to include in recommendation summaries (default 3)',
  },
};

export function qualityStatusHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const args = input as { window_hours?: number; min_samples?: number } | undefined;
    return toTextContent(await daemon.qualityStatus({
      window_hours: args?.window_hours,
      min_samples: args?.min_samples,
    }));
  };
}
