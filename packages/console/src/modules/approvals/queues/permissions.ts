import type { PermissionRequestRow } from "@penumbra/api-contract";

import type { DaemonActionSpec } from "@src/hooks/useDaemonAction";
import { approvalsPermissions } from "@src/lib/query-keys";

import type { ApprovalItem, ErasedQueue } from "./types";

function toItem(row: PermissionRequestRow): ApprovalItem {
  return {
    id: row.permission_id,
    ts: row.created_at,
    title: row.tool_name,
    subtitle: row.agent_name,
  };
}

const approve: DaemonActionSpec<ApprovalItem, unknown> = {
  id: "permission-approve",
  tier: "safe",
  label: "Approve",
  run: (client, args) => client.permissions.decide(args.id, { decision: "approve" }),
  invalidate: () => [approvalsPermissions()],
};

const reject: DaemonActionSpec<ApprovalItem, unknown> = {
  id: "permission-reject",
  tier: "guarded",
  label: "Reject",
  run: (client, args, ctx) =>
    client.permissions.decide(args.id, { decision: "reject", reason: ctx.reason }),
  invalidate: () => [approvalsPermissions()],
};

export const permissionsQueue: ErasedQueue = {
  kind: "permission",
  queryKey: approvalsPermissions,
  topic: "permission-events",
  async fetch(client) {
    const res = await client.permissions.list({ status: "pending" });
    return res.permissions.map(toItem);
  },
  approve,
  reject,
};
