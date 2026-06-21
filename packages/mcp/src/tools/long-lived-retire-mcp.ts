import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const LongLivedRetireInputShape = {
  id: z.string().min(1),
};

export function longLivedRetireHandler(daemon: DaemonClient) {
  return async (input: { id: string }): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.longLivedRetire(input.id));
}
