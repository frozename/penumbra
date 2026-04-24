import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import { RecallRequestSchema } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';

export const RecallInputShape = {
  query: z.string().min(1),
  project_id: z.string().nullable().optional(),
  limit: z.number().int().positive().max(200).optional(),
  include_raw: z.boolean().optional(),
  min_score: z.number().min(0).max(1).optional(),
};

/**
 * Unlike observeHandler, recall requires no server-side identity injection —
 * RecallRequestSchema fields are all LLM-addressable or have schema defaults.
 */
export function recallHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = RecallRequestSchema.parse({
      ...(input as object),
      // Explicit `?? null` guards against RecallRequestSchema losing its .default(null) later.
      project_id: (input as { project_id?: string | null }).project_id ?? null,
    });
    const r = await daemon.recall(parsed);
    return toTextContent(r);
  };
}
