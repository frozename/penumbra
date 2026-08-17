import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const LongLivedRejectActionInputShape = {
  action_id: z.string().min(1),
  reason: z.string().min(1).optional(),
  decided_by: z.string().min(1).optional(),
};

export function longLivedRejectActionHandler(daemon: DaemonClient) {
  return async (input: {
    action_id: string;
    reason?: string;
    decided_by?: string;
  }): Promise<TextContentEnvelope> =>
    toTextContent(
      await daemon.longLivedRejectAction(input.action_id, input.reason, input.decided_by),
    );
}
