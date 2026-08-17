import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const LongLivedPauseInputShape = {
  id: z.string().min(1),
};

export function longLivedPauseHandler(daemon: DaemonClient) {
  return async (input: { id: string }): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.longLivedPause(input.id));
}
