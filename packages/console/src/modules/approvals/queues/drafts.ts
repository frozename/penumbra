import type { SessionNoteDraft } from "@penumbra/api-contract";

import type { DaemonActionSpec } from "@src/hooks/useDaemonAction";
import { approvalsDrafts, sessionNoteDraftsInvalidations } from "@src/lib/query-keys";

import type { ApprovalItem, ErasedQueue } from "./types";

function toItem(row: SessionNoteDraft): ApprovalItem {
  return {
    id: row.draft_id,
    ts: row.composed_at,
    title: row.period_key,
    subtitle: row.draft_path,
  };
}

const approve: DaemonActionSpec<ApprovalItem, unknown> = {
  id: "draft-approve",
  tier: "safe",
  label: "Approve",
  run: (client, args) => client.sessionNotes.approve({ draft_id: args.id, approve: true }),
  invalidate: () => [...sessionNoteDraftsInvalidations()],
};

export const draftsQueue: ErasedQueue = {
  kind: "draft",
  queryKey: approvalsDrafts,
  async fetch(client) {
    const res = await client.sessionNotes.drafts({ status: "awaiting_approval" });
    return res.drafts.map(toItem);
  },
  approve,
};
