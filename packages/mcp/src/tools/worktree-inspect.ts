import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";
import { type ToolHandler, type ToolResult } from "./context.js";

export const WorktreeInspectInputShape = {
  handoff_id: z.string().min(1).describe("The handoff ID to inspect the worktree for"),
};

export function worktreeInspectHandler(daemon: DaemonClient): ToolHandler<{ handoff_id: string }> {
  return async (input): Promise<ToolResult> => {
    try {
      const res = await daemon.inspectWorktree(input.handoff_id);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (err) {
      if (err instanceof DaemonHttpError && err.status === 404) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: { code: "not_found", message: err.message } }),
            },
          ],
          isError: true,
        };
      }
      throw err;
    }
  };
}
