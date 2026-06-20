import { z } from "zod";
import { DaemonHttpError, type DaemonClient } from "../daemon-client.js";

export const ChainWaitInputShape = {
  conversation_id: z.string().describe("The conversation ID to wait for."),
  timeout_ms: z.number().optional().default(60000).describe("Timeout in ms (default 60000)."),
};

import { formatChainWait, wrapWithSummary } from "../format-summary.js";

export const chainWaitHandler =
  (daemon: DaemonClient) => async (args: { conversation_id: string; timeout_ms?: number }) => {
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
          const payload = {
            status: handoff.status,
            last_handoff_id: lastHandoffId,
            error: handoff.error_message ?? undefined,
          };
          const elapsedMs = Date.now() - start;
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
      } catch (err: any) {
        // 404 means the chain isn't yet visible — keep polling.
        // Hard daemon errors (401/403/5xx) are not transient: surface them
        // immediately as a structured error payload so callers fail fast
        // instead of blocking until timeout.
        if (err instanceof DaemonHttpError) {
          const status = err.status;
          if (status !== 404) {
            const isHardError = status === 401 || status === 403 || status >= 500;
            if (isHardError) {
              const payload = {
                status: "error" as const,
                code: status,
                message: err.message,
                last_handoff_id: lastHandoffId,
              };
              const elapsedMs = Date.now() - start;
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
          }
        }
        // Non-DaemonHttpError (e.g. fetch network blip) and 404 fall through to keep polling.
      }

      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval * 1.5, 2000);
    }

    const payload = {
      status: "timeout",
      last_handoff_id: lastHandoffId,
    };
    const elapsedMs = Date.now() - start;
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
  };
