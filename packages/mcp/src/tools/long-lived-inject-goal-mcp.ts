import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const LongLivedInjectGoalInputShape = {
  id: z.string().min(1),
  goal: z.string().min(1),
};

export function longLivedInjectGoalHandler(daemon: DaemonClient) {
  return async (input: { id: string; goal: string }): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.longLivedInjectGoal(input.id, input.goal));
}
