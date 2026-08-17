import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const LongLivedResumeInputShape = {
  id: z.string().min(1),
};

export function longLivedResumeHandler(daemon: DaemonClient) {
  return async (input: { id: string }): Promise<TextContentEnvelope> =>
    toTextContent(await daemon.longLivedResume(input.id));
}
