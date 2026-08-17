import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const WorkflowSuggestInputShape = {
  now: z.string().optional().describe("Optional ISO8601 override for state-threshold evaluation."),
};

const WorkflowSuggestSchema = z.object(WorkflowSuggestInputShape).strict();

export function workflowSuggestHandler(
  daemon: DaemonClient,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = WorkflowSuggestSchema.parse(input);
    return toTextContent(await daemon.workflowSuggest(parsed));
  };
}
