import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const WorkflowSuggestInputShape = {
  now: z.string().optional().describe("Optional ISO8601 override for state-threshold evaluation."),
};

const WorkflowSuggestSchema = z.object(WorkflowSuggestInputShape).strict();

export function workflowSuggestHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = WorkflowSuggestSchema.parse(input);
    return toTextContent(await daemon.workflowSuggest(parsed));
  };
}
