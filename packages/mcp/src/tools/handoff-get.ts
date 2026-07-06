import { z } from "zod";

import type { DaemonClient, HandoffShape } from "../daemon-client.js";

import { DaemonHttpError } from "../daemon-client.js";
import { formatHandoffGet, wrapWithSummary } from "../format-summary.js";
import { type ToolHandler, type ToolResult } from "./context.js";

export const HandoffGetInputShape = {
  handoff_id: z.string().min(1).describe("The ID of the handoff to retrieve."),
  compact: z
    .boolean()
    .optional()
    .describe(
      "When true, omits the original prompt and truncates resolution_reason to head 500 + tail 500 chars. Saves ~1500-2500 tokens per call. Default false.",
    ),
};

function applyCompactTransform(handoff: HandoffShape): HandoffShape {
  const out: HandoffShape = { ...handoff };
  delete (out as { message?: unknown }).message;
  const reason = out.resolution_reason;
  if (typeof reason === "string" && reason.length > 1100) {
    const head = reason.slice(0, 500);
    const tail = reason.slice(-500);
    const truncated = reason.length - 1000;
    out.resolution_reason = `${head}\n[... truncated ${String(truncated)} chars ...]\n${tail}`;
  }
  return out;
}

interface NotFoundBody {
  error: { code: string; message: string };
}

export const handoffGetHandler =
  (daemon: DaemonClient): ToolHandler<{ handoff_id: string; compact?: boolean }> =>
  async (args): Promise<ToolResult> => {
    try {
      const { handoff } = await daemon.getHandoff(args.handoff_id);
      const output = args.compact ? applyCompactTransform(handoff) : handoff;
      const payload = { handoff: output };
      const formatterInput = {
        handoff: {
          handoff_id: output.handoff_id,
          to_agent: typeof output.to_agent === "string" ? output.to_agent : "",
          status: output.status,
        },
      };
      return {
        content: [
          {
            type: "text",
            text: wrapWithSummary(formatHandoffGet(formatterInput), payload),
          },
        ],
      };
    } catch (err) {
      if (isNotFound(err)) {
        const payload = notFoundBody(err, args.handoff_id);
        return {
          content: [
            {
              type: "text",
              text: wrapWithSummary(`◑ handoff  not found`, payload),
            },
          ],
        };
      }
      throw err;
    }
  };

function isNotFound(err: unknown): err is DaemonHttpError {
  return err instanceof DaemonHttpError && err.status === 404;
}

function notFoundBody(
  err: DaemonHttpError | { body?: unknown },
  handoff_id: string,
): NotFoundBody | object {
  const body = "body" in err ? err.body : undefined;
  if (typeof body === "object" && body !== null && "error" in body) {
    return body;
  }
  return { error: { code: "not_found", message: `handoff ${handoff_id} not found` } };
}
