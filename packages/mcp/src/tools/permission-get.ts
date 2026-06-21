import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";
import { type ToolHandler, type ToolResult } from "./context.js";

export const PermissionGetInputShape = {
  permission_id: z.string().min(1).describe("The permission_id to fetch."),
};

interface NotFoundBody {
  error: { code: string; message: string };
}

export const permissionGetHandler =
  (daemon: DaemonClient): ToolHandler<{ permission_id: string }> =>
  async (args): Promise<ToolResult> => {
    try {
      const { permission } = await daemon.getPermission(args.permission_id);
      const rawJson = JSON.stringify({ permission }, null, 2);
      return {
        content: [{ type: "text", text: rawJson }],
      };
    } catch (err) {
      if (isNotFound(err)) {
        return {
          content: [
            {
              type: "text",
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

function notFoundBody(
  err: DaemonHttpError | { body?: unknown },
  permission_id: string,
): NotFoundBody | object {
  const body = "body" in err ? err.body : undefined;
  if (typeof body === "object" && body !== null && "error" in body) {
    return body;
  }
  return { error: { code: "not_found", message: `permission ${permission_id} not found` } };
}
