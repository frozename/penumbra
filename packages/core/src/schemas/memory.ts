import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const T2MemorySchema = z.object({
  memory_id: z.string(),
  project_id: SafeProjectIdSchema.nullable(),
  user_id: z.string(),
  kind: z.string(),
  source_session_ids: z.array(z.string()),
  window_start: z.string(),
  window_end: z.string(),
  title: z.string(),
  body: z.string(),
  metadata_json: z.record(z.string(), z.unknown()),
  compressed_from: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type T2MemoryRow = z.infer<typeof T2MemorySchema>;
