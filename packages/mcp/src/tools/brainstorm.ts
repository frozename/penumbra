import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";

const BrainstormInputSchema = z
  .object({
    topic: z.string().min(1),
    constraints: z.string().min(1).optional(),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional absolute caller repo cwd for project and recall resolution; omitting it falls back to the MCP subprocess cwd.",
      ),
  })
  .strict();

export const BrainstormInputShape = BrainstormInputSchema.shape;

export interface BrainstormHandlerOpts {
  resolveCwd?: () => string;
}

export function brainstormHandler(
  daemon: Pick<DaemonClient, "workflowRun">,
  opts: BrainstormHandlerOpts = {},
) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = BrainstormInputSchema.parse(input ?? {});
    const resolvedCwd = parsed.cwd ?? opts.resolveCwd?.();
    const inferredCwd = parsed.cwd === undefined && resolvedCwd !== undefined;
    try {
      const out = await daemon.workflowRun({
        name: "brainstorm",
        wait: true,
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
        args: {
          topic: parsed.topic,
          ...(parsed.constraints ? { constraints: parsed.constraints } : {}),
        },
      });
      if (inferredCwd) {
        return toTextContent({
          ...(out as Record<string, unknown>),
          resolution_warning: "brainstorm_cwd_inferred_from_mcp_cwd",
        });
      }
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
