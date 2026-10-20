import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";
import { type ToolHandler, type ToolResult } from "./context.js";
import { handoffErrorContent, resolveHandoffId } from "./handoff-guard.js";

export const WorktreeInspectInputShape = {
  handoff_id: z.string().min(1).describe("The handoff ID to inspect the worktree for"),
};

export function worktreeInspectHandler(daemon: DaemonClient): ToolHandler<{ handoff_id: string }> {
  return async (input): Promise<ToolResult> => {
    const resolved = resolveHandoffId(input.handoff_id);
    if (!resolved.ok) {
      return handoffErrorContent(resolved.error.code, resolved.error.message);
    }
    try {
      const res = await daemon.inspectWorktree(resolved.handoff_id);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (err) {
      if (err instanceof DaemonHttpError) {
        const body = z
          .object({ error: z.object({ code: z.string(), message: z.string() }) })
          .safeParse(err.body);
        const error =
          err.status === 404
            ? { code: "not_found", message: err.message }
            : body.success
              ? body.data.error
              : { code: "unknown", message: err.message };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error }),
            },
          ],
          isError: true,
        };
      }
      throw err;
    }
  };
}
