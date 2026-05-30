import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { DaemonHttpError } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const PermissionGetInputShape = {
  permission_id: z.string().min(1).describe("The permission_id to fetch."),
  envelope: z
    .boolean()
    .optional()
    .describe(
      "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
    ),
};

export const permissionGetHandler =
  (daemon: DaemonClient) => async (args: { permission_id: string; envelope?: boolean }) => {
    try {
      const { permission } = await daemon.getPermission(args.permission_id);
      const rawJson = JSON.stringify({ permission }, null, 2);
      if (args.envelope) {
        const resultBytes = Buffer.byteLength(rawJson, "utf8");
        const { text, truncated } = truncateToTokens(rawJson, DEFAULT_BUDGET);
        return makeEnvelopeResult([{ type: "text", text }], {
          usedTokens: estimateTokens(text),
          limitTokens: DEFAULT_BUDGET,
          truncated,
          resultBytes,
        });
      }
      return {
        content: [{ type: "text" as const, text: rawJson }],
      };
    } catch (err) {
      if (isNotFound(err)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(notFoundBody(err, args.permission_id), null, 2),
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

function notFoundBody(err: DaemonHttpError | { body?: unknown }, permission_id: string) {
  const body = "body" in err ? err.body : undefined;
  if (typeof body === "object" && body !== null && "error" in body) {
    return body;
  }
  return { error: { code: "not_found", message: `permission ${permission_id} not found` } };
}
