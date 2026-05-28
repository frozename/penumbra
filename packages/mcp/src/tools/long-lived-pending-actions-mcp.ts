import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const LongLivedPendingActionsInputShape = {
  id: z.string().min(1),
  status: z.string().min(1).nullable().optional(),
};

export function longLivedPendingActionsHandler(daemon: DaemonClient) {
  return async (input: { id: string; status?: string | null }) =>
    toTextContent(await daemon.longLivedPendingActions(input.id, input.status ?? null));
}
