import { z } from "zod";

export const CONVERSATION_HOP_START_EVENT_TYPE = "hop-start";
export const CONVERSATION_TOKEN_EVENT_TYPE = "token";
export const CONVERSATION_HOP_END_EVENT_TYPE = "hop-end";
export const CONVERSATION_CHAIN_END_EVENT_TYPE = "chain-end";
export const CONVERSATION_MERGE_RESULT_EVENT_TYPE = "merge-result";
export const WORKER_CANCEL_EVENT_TYPE = "cancel";
export const WORKER_PING_EVENT_TYPE = "ping";
export const WORKER_AGENTCHAT_RELOAD_EVENT_TYPE = "agentchat_reload";

export const ConversationChainEndReasonSchema = z.enum([
  "completed",
  "error",
  "cancelled",
  "max_hops",
]);
export type ConversationChainEndReason = z.infer<typeof ConversationChainEndReasonSchema>;

export const ConversationHopStartEventSchema = z.object({
  type: z.literal(CONVERSATION_HOP_START_EVENT_TYPE),
  handoff_id: z.string(),
  chain_id: z.string(),
  idx: z.number().int().nonnegative(),
  agent_name: z.string(),
  status: z.literal("in_progress"),
});
export type ConversationHopStartEvent = z.infer<typeof ConversationHopStartEventSchema>;

export const ConversationTokenEventSchema = z.object({
  type: z.literal(CONVERSATION_TOKEN_EVENT_TYPE),
  handoff_id: z.string(),
  seq: z.number().int().nonnegative(),
  delta: z.string(),
});
export type ConversationTokenEvent = z.infer<typeof ConversationTokenEventSchema>;

export const ConversationHopEndEventSchema = z.object({
  type: z.literal(CONVERSATION_HOP_END_EVENT_TYPE),
  handoff_id: z.string(),
  chain_id: z.string(),
  text: z.string().optional(),
  next_handoff_id: z.string().nullable(),
  error: z.string().nullable(),
});
export type ConversationHopEndEvent = z.infer<typeof ConversationHopEndEventSchema>;

export const ConversationChainEndEventSchema = z.object({
  type: z.literal(CONVERSATION_CHAIN_END_EVENT_TYPE),
  chain_id: z.string(),
  reason: ConversationChainEndReasonSchema,
});
export type ConversationChainEndEvent = z.infer<typeof ConversationChainEndEventSchema>;

export const MergeResultEventSchema = z.object({
  type: z.literal(CONVERSATION_MERGE_RESULT_EVENT_TYPE),
  handoff_id: z.string(),
  status: z.enum([
    "merged",
    "rebased",
    "rebase_conflict",
    "test_failed",
    "typecheck_failed",
    "pr_opened",
    "pr_creation_failed",
    "no_changes",
  ]),
  conflict_files: z.array(z.string()).optional(),
  regression_summary: z.string().optional(),
  timed_out: z.boolean().optional(),
  worktree_dirty: z.boolean().optional(),
  pr_url: z.string().optional(),
  pr_number: z.number().optional(),
});
export type MergeResultEvent = z.infer<typeof MergeResultEventSchema>;

export const ConversationStreamEventSchema = z.discriminatedUnion("type", [
  ConversationHopStartEventSchema,
  ConversationTokenEventSchema,
  ConversationHopEndEventSchema,
  ConversationChainEndEventSchema,
  MergeResultEventSchema,
]);
export type ConversationStreamEvent = z.infer<typeof ConversationStreamEventSchema>;

export const WorkerCancelEventSchema = z.object({
  type: z.literal(WORKER_CANCEL_EVENT_TYPE),
  conversation_id: z.string(),
  handoff_id: z.string(),
});
export type WorkerCancelEvent = z.infer<typeof WorkerCancelEventSchema>;

export const WorkerPingEventSchema = z.object({
  type: z.literal(WORKER_PING_EVENT_TYPE),
  worker_id: z.string(),
  probe_id: z.string(),
});
export type WorkerPingEvent = z.infer<typeof WorkerPingEventSchema>;

export const WorkerAgentchatReloadEventSchema = z.object({
  type: z.literal(WORKER_AGENTCHAT_RELOAD_EVENT_TYPE),
});
export type WorkerAgentchatReloadEvent = z.infer<typeof WorkerAgentchatReloadEventSchema>;

export const WorkerControlStreamEventSchema = z.discriminatedUnion("type", [
  WorkerCancelEventSchema,
  WorkerPingEventSchema,
  WorkerAgentchatReloadEventSchema,
]);
export type WorkerControlStreamEvent = z.infer<typeof WorkerControlStreamEventSchema>;

export const HopStateCacheEntrySchema = z
  .object({
    conversation_id: z.string(),
    hop_start: ConversationHopStartEventSchema,
    tokens: z.array(ConversationTokenEventSchema),
  })
  .superRefine((value, ctx) => {
    for (let i = 0; i < value.tokens.length; i++) {
      const token = value.tokens[i]!;
      if (token.handoff_id !== value.hop_start.handoff_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tokens", i, "handoff_id"],
          message: "token handoff_id must match hop_start.handoff_id",
        });
      }
      if (i > 0) {
        const prev = value.tokens[i - 1]!;
        if (token.seq <= prev.seq) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tokens", i, "seq"],
            message: "token seq values must be strictly increasing",
          });
        }
      }
    }
  });
export type HopStateCacheEntry = z.infer<typeof HopStateCacheEntrySchema>;
