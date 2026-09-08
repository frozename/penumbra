import type { HandoffRow } from "@penumbra/api-contract";

import type { DaemonActionSpec } from "@src/hooks/useDaemonAction";
import { approvalsHandoffs, handoffsPendingInvalidations } from "@src/lib/query-keys";

import type { ApprovalItem, ErasedQueue } from "./types";

function toItem(row: HandoffRow): ApprovalItem {
  return {
    id: row.handoff_id,
    ts: row.ts,
    title: row.message,
    subtitle: `${row.from_agent} → ${row.to_agent}`,
  };
}

const approve: DaemonActionSpec<ApprovalItem, unknown> = {
  id: "handoff-approve",
  tier: "safe",
  label: "Approve",
  run: (client, args) => client.handoffs.approve(args.id),
  invalidate: () => [...handoffsPendingInvalidations()],
};

const reject: DaemonActionSpec<ApprovalItem, unknown> = {
  id: "handoff-reject",
  tier: "guarded",
  label: "Reject",
  run: (client, args, ctx) =>
    client.handoffs.approve(args.id, { reject: true, reason: ctx.reason }),
  invalidate: () => [...handoffsPendingInvalidations()],
};

export const handoffsQueue: ErasedQueue = {
  kind: "handoff",
  queryKey: approvalsHandoffs,
  async fetch(client) {
    const res = await client.handoffs.list({ status: "pending" });
    return res.handoffs.map(toItem);
  },
  approve,
  reject,
};
