import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { formatPermissionListPending, wrapWithSummary } from "../format-summary.js";

export const PermissionListPendingInputShape = {
  conversation_id: z.string().optional().describe("Filter to a single conversation."),
  parent_handoff_id: z.string().optional().describe("Filter to a single dispatch."),
  status: z
    .string()
    .optional()
    .describe(
      "Comma-separated status filter (default: pending). Allowed: pending,approved,rejected,expired.",
    ),
};

interface PermissionListResult {
  content: { type: "text"; text: string }[];
}

export const permissionListPendingHandler =
  (
    daemon: DaemonClient,
  ): ((args: {
    conversation_id?: string;
    parent_handoff_id?: string;
    status?: string;
  }) => Promise<PermissionListResult>) =>
  async (args): Promise<PermissionListResult> => {
    const payload = await daemon.listPermissions({
      status: args.status,
      conversation_id: args.conversation_id,
      parent_handoff_id: args.parent_handoff_id,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: wrapWithSummary(formatPermissionListPending(payload), payload),
        },
      ],
    };
  };
