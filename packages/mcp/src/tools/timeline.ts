import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const TimelineInputShape = {
  anchor: z.string().min(1).describe('Observation ID to center the timeline around'),
  depth_before: z.number().int().min(0).max(50).optional(),
  depth_after: z.number().int().min(0).max(50).optional(),
  project_id: z.string().nullable().optional(),
};

export function timelineHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const out = await daemon.memoryTimeline(input);
    return toTextContent(out);
  };
}
