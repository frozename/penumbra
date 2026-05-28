import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

export const WorktreeInspectInputShape = {
  handoff_id: z.string().min(1).describe("The handoff ID to inspect the worktree for"),
};

export function worktreeInspectHandler(daemon: DaemonClient) {
  return async (input: any) => {
    try {
      const res = await daemon.inspectWorktree(input.handoff_id);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (err: any) {
      if (err.status === 404) {
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
