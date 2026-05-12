import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const MemoryEfficacyJobStatusInputShape = {
  job_id: {
    type: 'string' as const,
    description: 'The job_id returned by memory.efficacy_rebuild',
  },
};

export function memoryEfficacyJobStatusHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const args = input as { job_id: string };
    return toTextContent(
      await daemon.memoryEfficacyJobStatus({ job_id: args.job_id }),
    );
  };
}
