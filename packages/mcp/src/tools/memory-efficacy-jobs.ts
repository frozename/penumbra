import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const MemoryEfficacyJobsInputShape = {
  limit: {
    type: 'number' as const,
    description: 'Max jobs to return (default 20)',
  },
  status: {
    type: 'string' as const,
    description: 'Filter by status: pending, running, completed, failed',
  },
};

export function memoryEfficacyJobsHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const args = input as { limit?: number; status?: string } | undefined;
    return toTextContent(
      await daemon.memoryEfficacyJobs({ limit: args?.limit, status: args?.status }),
    );
  };
}
