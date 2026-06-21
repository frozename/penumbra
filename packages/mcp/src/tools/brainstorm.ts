import { type TextContentEnvelope, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";

const BrainstormInputSchema = z
  .object({
    topic: z.string().min(1),
    constraints: z.string().min(1).optional(),
  })
  .strict();

export const BrainstormInputShape = BrainstormInputSchema.shape;

export function brainstormHandler(daemon: Pick<DaemonClient, "workflowRun">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = BrainstormInputSchema.parse(input ?? {});
    try {
      const out = await daemon.workflowRun({
        name: "brainstorm",
        wait: true,
        args: {
          topic: parsed.topic,
          ...(parsed.constraints ? { constraints: parsed.constraints } : {}),
        },
      });
      return toTextContent(out);
    } catch (err) {
      if (err instanceof DaemonHttpError && err.status === 404) {
        return toTextContent({
          error: {
            code: "workflow_missing",
            workflow: "brainstorm",
            message: "workflow brainstorm is not registered",
          },
        });
      }
      throw err;
    }
  };
}
