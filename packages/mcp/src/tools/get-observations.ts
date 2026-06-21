import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const GetObservationsInputShape = {
  ids: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe(
      "IDs returned by memory.search or memory.timeline. Always batch — do not call once per ID.",
    ),
};

export function getObservationsHandler(daemon: DaemonClient) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const out = await daemon.memoryGet(input);
    return toTextContent(out);
  };
}
