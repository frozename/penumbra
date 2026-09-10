import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const WorkflowReportInputShape = {
  window_hours: z.number().int().min(1).max(2160).optional(),
  project_id: z.string().min(1).optional(),
};

const WorkflowReportSchema = z.object(WorkflowReportInputShape).strict();

export function workflowReportHandler(
  daemon: DaemonClient,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = WorkflowReportSchema.parse(input);
    return toTextContent(await daemon.workflowReport(parsed));
  };
}
