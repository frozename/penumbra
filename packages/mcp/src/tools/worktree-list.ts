import type { DaemonClient } from "../daemon-client.js";

import { type ToolResult } from "./context.js";

export const WorktreeListInputShape = {};

export function worktreeListHandler(daemon: DaemonClient): () => Promise<ToolResult> {
  return async (): Promise<ToolResult> => {
    const res = await daemon.listWorktrees();
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  };
}
