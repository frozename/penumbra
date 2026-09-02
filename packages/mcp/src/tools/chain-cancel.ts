import { z } from "zod";

import type { HandoffStatus } from "@penumbra/core";

import type { DaemonClient } from "../daemon-client.js";

import { DaemonHttpError } from "../daemon-client.js";
import { type ToolHandler, type ToolResult } from "./context.js";

export const ChainCancelInputShape = {
  handoff_id: z.string().min(1).describe("The handoff ID to cancel."),
};

const TERMINAL_STATUSES = new Set<string>([
  "completed",
  "failed",
  "rejected",
  "expired",
] satisfies HandoffStatus[]);

interface NotFoundBody {
  error: { code: string; message: string };
}

export function chainCancelHandler(daemon: DaemonClient): ToolHandler<{ handoff_id: string }> {
  return async (args): Promise<ToolResult> => {
    try {
      const { handoff } = await daemon.getHandoff(args.handoff_id);
      const current_status = handoff.status;
      if (TERMINAL_STATUSES.has(current_status)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "already_terminal", current_status }, null, 2),
            },
          ],
        };
      }

      const cancelResult = await daemon.cancelConversation(handoff.conversation_id);
      if (!cancelResult.changed) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "no_change", current_status }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "cancel_requested", current_status }, null, 2),
          },
        ],
      };
    } catch (err) {
      if (isNotFound(err)) {
        return {
          content: [
            { type: "text", text: JSON.stringify(notFoundBody(err, args.handoff_id), null, 2) },
          ],
        };
      }
      throw err;
    }
  };
}

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
