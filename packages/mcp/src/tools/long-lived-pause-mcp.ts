import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const LongLivedPauseInputShape = {
  id: z.string().min(1),
};

export function longLivedPauseHandler(daemon: DaemonClient) {
  return async (input: { id: string }) => toTextContent(await daemon.longLivedPause(input.id));
}
