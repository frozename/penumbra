import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";
import { formatChainWait, wrapWithSummary } from "../format-summary.js";
import { type ToolHandler, type ToolResult } from "./context.js";

export const ChainWaitInputShape = {
  conversation_id: z.string().describe("The conversation ID to wait for."),
  timeout_ms: z.number().optional().default(60000).describe("Timeout in ms (default 60000)."),
};

interface WaitPayload {
  status: string;
  last_handoff_id?: string;
  error?: string;
  code?: number;
  message?: string;
}

function makeResult(payload: WaitPayload, elapsedMs: number): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: wrapWithSummary(
          formatChainWait(
            { status: payload.status, last_handoff_id: payload.last_handoff_id ?? "" },
            elapsedMs,
          ),
          payload,
        ),
      },
    ],
  };
}

function isHardDaemonError(status: number): boolean {
  return status === 401 || status === 403 || status >= 500;
}

function hardErrorResult(
  err: DaemonHttpError,
  lastHandoffId: string | undefined,
  start: number,
): ToolResult {
  const payload: WaitPayload = {
    status: "error",
    code: err.status,
    message: err.message,
    last_handoff_id: lastHandoffId,
  };
  return makeResult(payload, Date.now() - start);
}

export const chainWaitHandler =
  (daemon: DaemonClient): ToolHandler<{ conversation_id: string; timeout_ms?: number }> =>
  async (args): Promise<ToolResult> => {
    const timeout = args.timeout_ms ?? 60000;
    const start = Date.now();
    let interval = 200;
    let lastHandoffId: string | undefined;

    while (Date.now() - start < timeout) {
      try {
        const { handoff } = await daemon.getLatestHandoff(args.conversation_id);
        lastHandoffId = handoff.handoff_id;
        if (
          handoff.status === "completed" ||
          handoff.status === "failed" ||
          handoff.status === "rejected"
        ) {
          const payload: WaitPayload = {
            status: handoff.status,
            last_handoff_id: lastHandoffId,
            error: handoff.error_message ?? undefined,
          };
          return makeResult(payload, Date.now() - start);
        }
      } catch (err) {
        // 404 means the chain isn't yet visible — keep polling.
        // Hard daemon errors (401/403/5xx) are not transient: surface them
        // immediately as a structured error payload so callers fail fast
        // instead of blocking until timeout.
        if (err instanceof DaemonHttpError && err.status !== 404 && isHardDaemonError(err.status)) {
          return hardErrorResult(err, lastHandoffId, start);
        }
        // Non-DaemonHttpError (e.g. fetch network blip) and 404 fall through to keep polling.
      }

      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval * 1.5, 2000);
    }

    return makeResult({ status: "timeout", last_handoff_id: lastHandoffId }, Date.now() - start);
  };
