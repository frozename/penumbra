import { z } from "zod";
import { SafeProjectIdSchema } from "./project-id.js";

export const ObsTypeEnum = z
  .enum([
    "decision",
    "bugfix",
    "feature",
    "refactor",
    "discovery",
    "change",
    "security_alert",
    "security_note",
    "session",
    "other",
  ])
  .optional()
  .nullable();

export const SeverityEnum = z.enum(["info", "warn", "error"]).optional().nullable();

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

export const T2MemoryWriteSchema = z.object({
  memory_id: z.string(),
  project_id: SafeProjectIdSchema.nullable(),
  user_id: z.string(),
  kind: z.string(),
  source_session_ids: z.array(z.string()).optional().default([]),
  window_start: z.string(),
  window_end: z.string(),
  title: z.string(),
  body: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  compressed_from: z.string().optional().nullable(),
  embedding: z.instanceof(Float32Array),
  obs_type: ObsTypeEnum,
  concepts: z.array(z.string()).optional().default([]),
  severity: SeverityEnum,
  file_paths: z.array(z.string()).optional().default([]),
});

export type T2MemoryWriteInput = z.input<typeof T2MemoryWriteSchema>;
