import { z } from "zod";

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
