import type { HandoffRow } from "@penumbra/core";

export function buildDispatchHandoffInput(
  source: HandoffRow,
  dispatchedHandoff: HandoffRow,
): HandoffRow {
  return {
    ...dispatchedHandoff,
    handoff_id: source.handoff_id,
    // Prefer the branch recorded after applyWorktreeOverride materializes the
    // parent worktree; root handoffs often have no incoming branch_base.
    branch_base: dispatchedHandoff.branch_name ?? source.branch_name ?? source.branch_base ?? null,
  };
}
