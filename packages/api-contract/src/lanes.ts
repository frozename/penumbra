import { z } from "zod";

export const TaskClassSchema = z.enum(["BOUNDARY", "STANDARD", "TRIVIAL"]);
export type TaskClass = z.infer<typeof TaskClassSchema>;

export const LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES = 4096;

const NOTES_MAX = 2000;
const STRING_FIELD_MAX = 200;

export const LaneCloseMetadataSchema = z
  .object({
    round_count: z.number().int().min(0).max(100).optional(),
    high_findings: z.number().int().min(0).max(1000).optional(),
    medium_findings: z.number().int().min(0).max(1000).optional(),
    low_findings: z.number().int().min(0).max(1000).optional(),
    implementer_duration_ms: z.number().int().min(0).max(86_400_000).optional(),
    reviewer_agent: z.string().min(1).max(STRING_FIELD_MAX).optional(),
    review_synth_dir: z.string().min(1).max(STRING_FIELD_MAX).optional(),
    notes: z.string().min(1).max(NOTES_MAX).optional(),
  })
  .strict();

export type LaneCloseMetadata = z.infer<typeof LaneCloseMetadataSchema>;

export const OpenLaneRequestSchema = z.object({
  lane_id: z.string().min(1),
  implementer_handoff: z.string().min(1),
  task_class: TaskClassSchema,
});
export type OpenLaneRequest = z.infer<typeof OpenLaneRequestSchema>;

export const CloseLaneRequestSchema = z.object({
  lane_id: z.string().min(1),
  gate_status: z.enum(["passed", "failed", "skipped", "review_debt"]),
  reviewer_handoff: z.string().min(1).optional(),
  override_reason: z.string().min(1).optional(),
  metadata: LaneCloseMetadataSchema.optional(),
});
export type CloseLaneRequest = z.infer<typeof CloseLaneRequestSchema>;

export const RecentLaneQuerySchema = z.object({
  status: z.enum(["open", "passed", "failed", "skipped", "review_debt"]).optional(),
  task_class: TaskClassSchema.optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).default(50),
});
export type RecentLaneQuery = z.infer<typeof RecentLaneQuerySchema>;
export type RecentLaneQueryInput = z.input<typeof RecentLaneQuerySchema>;

const LaneRowSchema = z
  .object({
    lane_id: z.string(),
    ts_opened: z.string(),
    ts_closed: z.string().nullable(),
    task_class: TaskClassSchema,
    implementer_handoff: z.string(),
    reviewer_handoff: z.string().nullable(),
    gate_status: z.enum(["open", "passed", "failed", "skipped", "review_debt"]),
    recalled_memory_ids: z.array(z.string()),
    recalled_query: z.string().nullable(),
    override_reason: z.string().nullable(),
    metadata_json: z.string(),
  })
  .loose();
export type LaneRow = z.infer<typeof LaneRowSchema>;

export const LanesRecentResponseSchema = z
  .object({
    lanes: z.array(LaneRowSchema),
  })
  .loose();
export type LanesRecentResponse = z.infer<typeof LanesRecentResponseSchema>;
