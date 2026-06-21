import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const WorkflowHistoryInputShape = {
  name: z.string().min(1).describe("Workflow name to fetch history for."),
};

const WorkflowHistorySchema = z.object(WorkflowHistoryInputShape).strict();

export function workflowHistoryHandler(
  daemon: DaemonClient,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = WorkflowHistorySchema.parse(input);
    return toTextContent(await daemon.workflowHistory(parsed));
  };
}
