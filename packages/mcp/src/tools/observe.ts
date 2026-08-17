import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { T0EventInputSchema, TASK_DRAFT_LIFECYCLE_EVENT_TYPES } from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

const ObserveBaseEventTypes = [
  "agent-prompt",
  "agent-tool-use",
  "agent-response",
  "request",
  "response",
] as const;

export const ObserveInputShape = {
  ts: z.string(),
  source: z.enum(["mcp", "transcript", "sirius-middleware", "claude-code", "agentchat"]),
  source_detail: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  event_type: z.enum([...ObserveBaseEventTypes, ...TASK_DRAFT_LIFECYCLE_EVENT_TYPES]),
  lane: z.enum(["local", "cloud", "cli-subscription", "unknown"]),
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
  return async (input: unknown): Promise<TextContentEnvelope> => {
    // ObserveInputShape (the MCP tool's input schema) intentionally omits
    // user_id/machine_id because the LLM doesn't know them. T0EventInputSchema
    // requires both. The daemon's normalize() overrides them with ctx values
    // from services.machineId — the placeholders below are discarded at the
    // ingest boundary.
    const parsed = ObserveSchema.parse(input);
    const event = T0EventInputSchema.parse({
      ...parsed,
      user_id: "mcp-client",
      machine_id: "mcp-client",
    });
    const r = await daemon.observe(event);
    return toTextContent(r);
  };
}
