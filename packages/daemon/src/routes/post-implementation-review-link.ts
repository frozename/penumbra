import type { Services } from "@penumbra/core";

import {
  POST_IMPLEMENTATION_REVIEW_RESOLVER,
  REVIEW_TARGET_EVENT,
  type ReviewTarget,
} from "@penumbra/api-contract";

export interface PostImplementationReviewLink {
  laneId: string;
  implementerHandoff: string;
  projectId: string;
  reviewer: string;
  signal: AbortSignal;
  target: ReviewTarget;
}

export function linkPostImplementationReviewer(
  services: Services,
  link: PostImplementationReviewLink,
  routedAgent: string,
  reviewerHandoff: string,
  ts: string,
): boolean {
  if (
    link.signal.aborted ||
    routedAgent !== link.reviewer ||
    services.projectRegistry?.get(link.projectId)?.post_implementation_reviewer !== link.reviewer
  ) {
    return false;
  }
  // Run inside chain admission's transaction before the handoff becomes visible to workers.
  const linked =
    services.db
      .query(
        `
      UPDATE lane_ledger SET reviewer_handoff = ?
       WHERE lane_id = ? AND implementer_handoff = ?
         AND task_class = 'STANDARD' AND gate_status = 'open' AND reviewer_handoff IS NULL
         AND EXISTS (
           SELECT 1 FROM handoffs h
            WHERE h.handoff_id = lane_ledger.implementer_handoff AND h.status = 'completed'
              AND h.project_id = ? AND h.to_agent <> ? AND h.chain_task_type = 'implement_small'
              AND h.use_worktree = 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM handoffs child
            WHERE child.parent_handoff_id = lane_ledger.implementer_handoff
              AND child.chain_task_type = 'review_adversarial'
         )
         AND NOT EXISTS (
           SELECT 1 FROM lane_ledger active
            JOIN handoffs reviewer ON reviewer.handoff_id = active.reviewer_handoff
           WHERE active.gate_status = 'open'
             AND reviewer.project_id = ? AND reviewer.resolved_by = ?
             AND reviewer.status IN ('pending', 'approved', 'redirected', 'dispatched')
         )`,
      )
      .run(
        reviewerHandoff,
        link.laneId,
        link.implementerHandoff,
        link.projectId,
        routedAgent,
        link.projectId,
        POST_IMPLEMENTATION_REVIEW_RESOLVER,
      ).changes === 1;
  if (linked) {
    services.dispatchEventLog.record({
      handoff_id: reviewerHandoff,
      source: "daemon",
      kind: REVIEW_TARGET_EVENT,
      ts,
      meta: link.target,
    });
  }
  return linked;
}
