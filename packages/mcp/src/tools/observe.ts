import { z } from 'zod';
import { T0EventInputSchema } from '@penumbra/core';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const ObserveInputShape = {
  ts: z.string(),
  source: z.enum(['mcp', 'transcript', 'sirius-middleware', 'claude-code', 'agentchat']),
  source_detail: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  event_type: z.enum([
    'agent-prompt', 'agent-tool-use', 'agent-response', 'request', 'response',
    // Task-discipline pipeline (docs/specs/2026-05-15-task-discipline.md):
    // append-only lifecycle for refiner-managed task drafts.
    'task_draft',
    'task_draft_refining',
    'task_draft_promoted',
    'task_draft_stale',
    'task_draft_duplicate',
    'task_draft_escalation',
  ]),
  lane: z.enum(['local', 'cloud', 'cli-subscription', 'unknown']),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  tokens_in: z.number().int().nullable().optional(),
  tokens_out: z.number().int().nullable().optional(),
  cost_usd: z.number().nullable().optional(),
  latency_ms: z.number().int().nullable().optional(),
  request_id: z.string().nullable().optional(),
  payload_json: z.record(z.string(), z.unknown()),
  payload_summary: z.string().nullable().optional(),
};

const ObserveSchema = z.object(ObserveInputShape).strict();

export function observeHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    // ObserveInputShape (the MCP tool's input schema) intentionally omits
    // user_id/machine_id because the LLM doesn't know them. T0EventInputSchema
    // requires both. The daemon's normalize() overrides them with ctx values
    // from services.machineId — the placeholders below are discarded at the
    // ingest boundary.
    const parsed = ObserveSchema.parse(input);
    const event = T0EventInputSchema.parse({
      ...parsed,
      user_id: 'mcp-client',
      machine_id: 'mcp-client',
    });
    const r = await daemon.observe(event);
    return toTextContent(r);
  };
}
