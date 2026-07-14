import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { type ToolHandler, type ToolResult } from "./context.js";
import { handoffErrorContent, resolveHandoffId } from "./handoff-guard.js";

export const WorktreeCleanupInputShape = {
  handoff_id: z.string().min(1).describe("The handoff ID to cleanup the worktree for"),
  force: z
    .boolean()
    .optional()
    .describe("Whether to force cleanup even if there are uncommitted changes"),
};

/**
 * Cross-dispatch access is denied at the tool boundary via
 * {@link resolveHandoffId}: when the MCP server is running inside a dispatch
 * (PENUMBRA_HANDOFF_ID set), an explicit handoff_id that does not match the
 * ambient one is rejected with `cross_handoff_denied` before any daemon
 * call is made. In maestro/operator context (env unset) the caller may
 * cleanup any worktree by supplying handoff_id explicitly.
 */
export function worktreeCleanupHandler(
  daemon: DaemonClient,
): ToolHandler<{ handoff_id: string; force?: boolean }> {
  return async (input): Promise<ToolResult> => {
    const resolved = resolveHandoffId(input.handoff_id);
    if (!resolved.ok) {
      return handoffErrorContent(resolved.error.code, resolved.error.message);
    }
    const res = await daemon.cleanupWorktree(resolved.handoff_id, input.force);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  };
}
