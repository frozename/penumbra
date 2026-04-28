import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const SourceSchema = z.enum(['mcp', 'transcript', 'sirius-middleware', 'claude-code', 'agentchat']);
export const LaneSchema = z.enum(['local', 'cloud', 'cli-subscription', 'unknown']);
export const EventTypeSchema = z.enum([
  'agent-prompt',
  'agent-tool-use',
  'agent-response',
  'agent-handoff',
  'user-prompt',
  'request',
  'response',
  'chain-terminated',
  'permission-requested',
  'permission-decided',
  'permission-expired',
]);

export const T0EventSchema = z.object({
  event_id: z.string(),
  ts: z.string(),
  ingest_ts: z.string(),
  source: SourceSchema,
  source_detail: z.string().nullable(),
  project_id: SafeProjectIdSchema.nullable(),
  user_id: z.string(),
  machine_id: z.string(),
  session_id: z.string().nullable(),
  event_type: EventTypeSchema,
  lane: LaneSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  latency_ms: z.number().int().nullable(),
  request_id: z.string().nullable(),
  payload_json: z.record(z.string(), z.unknown()),
  payload_summary: z.string().nullable(),
});

export type T0Event = z.infer<typeof T0EventSchema>;

export const T0EventInputSchema = T0EventSchema.partial({
  event_id: true,
  ingest_ts: true,
  source_detail: true,
  project_id: true,
  session_id: true,
  provider: true,
  model: true,
  tokens_in: true,
  tokens_out: true,
  cost_usd: true,
  latency_ms: true,
  request_id: true,
  payload_summary: true,
});

export type T0EventInput = z.infer<typeof T0EventInputSchema>;
