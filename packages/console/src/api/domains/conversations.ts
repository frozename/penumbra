import { z } from "zod";

import type { DaemonTransport } from "../transport.js";

import { fillPath } from "../paths.js";

export const PATHS = {
  cancel: "/conversations/:id/cancel",
} as const;

const ConversationCancelResponseSchema = z
  .object({
    ok: z.literal(true),
    changed: z.number().int().nonnegative(),
  })
  .loose();
type ConversationCancelResponse = z.infer<typeof ConversationCancelResponseSchema>;

export interface ConversationsSlice {
  cancel(conversationId: string): Promise<ConversationCancelResponse>;
}

export function conversationsSlice(t: DaemonTransport): ConversationsSlice {
  return {
    cancel(conversationId: string): Promise<ConversationCancelResponse> {
      return t.request({
        method: "POST",
        path: fillPath(PATHS.cancel, { id: conversationId }),
        body: {},
        schema: ConversationCancelResponseSchema,
      });
    },
  };
}
