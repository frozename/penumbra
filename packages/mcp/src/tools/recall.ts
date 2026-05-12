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
  session_id: z.string().optional().describe('Limit results to a single chain or session id.'),
  event_types: z.array(z.string()).optional().describe('Limit t0 results to these event_type values (e.g. ["agent-thought","agent-response"]).'),
  file_path: z.string().optional().describe('Restrict t0 results to events that touched this file path (joined via t0_file_refs).'),
};

const RecallSchema = z.object(RecallInputShape).strict();

/**
 * Unlike observeHandler, recall requires no server-side identity injection —
 * RecallRequestSchema fields are all LLM-addressable or have schema defaults.
 */
export function recallHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = RecallSchema.parse(input);
    const request = RecallRequestSchema.parse({
      ...parsed,
      // Explicit `?? null` guards against RecallRequestSchema losing its .default(null) later.
      project_id: parsed.project_id ?? null,
    });
    const r = await daemon.recall(request);
    return toTextContent(r);
  };
}
