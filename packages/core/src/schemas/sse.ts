import { z } from "zod";

/**
 * SSE wire-format for conversation progress streaming.
 */

export const SSEHopStartSchema = z.object({
  type: z.literal("hop-start"),
  handoff_id: z.string(),
  agent: z.string(),
});

export const SSETokenSchema = z.object({
  type: z.literal("token"),
  handoff_id: z.string(),
  seq: z.number().int(),
  text: z.string(),
});

export const SSEHopEndSchema = z.object({
  type: z.literal("hop-end"),
  handoff_id: z.string(),
  text: z.string(),
});

export const SSEChainEndSchema = z.object({
  type: z.literal("chain-end"),
  conversation_id: z.string(),
  reason: z.enum(["completed", "max_hops", "error"]),
  error_message: z.string().nullable().optional(),
});

export const SSEEventSchema = z.discriminatedUnion("type", [
  SSEHopStartSchema,
  SSETokenSchema,
  SSEHopEndSchema,
  SSEChainEndSchema,
]);

export type SSEEvent = z.infer<typeof SSEEventSchema>;

/**
 * SSE wire-format for worker control stream.
 */

export const WorkerControlCancelSchema = z.object({
  type: z.literal("cancel"),
  conversation_id: z.string(),
});

export const WorkerControlEventSchema = z.discriminatedUnion("type", [WorkerControlCancelSchema]);

export type WorkerControlEvent = z.infer<typeof WorkerControlEventSchema>;
