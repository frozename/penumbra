import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const TaskLinkGhInputSchema = z
  .object({
    task_id: z.string().min(1),
    repo: z.string().min(1),
    issue_number: z.number().int().positive(),
  })
  .strict();
export const TaskLinkGhInputShape = TaskLinkGhInputSchema.shape;

export function taskLinkGhHandler(daemon: Pick<DaemonClient, "taskLinkGh">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = TaskLinkGhInputSchema.parse(input ?? {});
    const out = await daemon.taskLinkGh(parsed.task_id, {
      repo: parsed.repo,
      issue_number: parsed.issue_number,
    });
    return toTextContent(out);
  };
}
