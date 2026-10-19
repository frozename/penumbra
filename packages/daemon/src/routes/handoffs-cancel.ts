import type { HandoffRow, Services } from "@penumbra/core";

import { maybeTeardownLongLivedTick } from "../long-lived/teardown.js";
import { json } from "./_helpers.js";

function failAsCancelled(services: Services, handoff_id: string): HandoffRow | null {
  const cancelledAtIso = services.clock().toISOString();
  services.handoffWriter.markFailed(handoff_id, {
    reason: "cancelled",
    resolved_by: "cancel",
    ts: cancelledAtIso,
  });
  const cancelled = services.handoffReader.get(handoff_id);
  if (cancelled) {
    maybeTeardownLongLivedTick({
      services,
      handoff_id,
      dispatch_kind: cancelled.dispatch_kind,
      long_lived_tick_id: cancelled.long_lived_tick_id,
      outcome: "failed",
      error: "cancelled",
      resolved_at_iso: cancelledAtIso,
    });
  }
  return cancelled;
}

export function completeCancelFallback(services: Services, handoff_id: string): Response {
  failAsCancelled(services, handoff_id);
  return json({ handoff_id, status: "failed", reason: "cancelled" });
}

// claimDispatch refuses a cancel-requested row, so the claim route must also
// take it out of approved: a worker re-arms a 409'd claim, and a row that stays
// claimable but always refused would never resolve.
export function claimCancelRequestedResponse(
  services: Services,
  row: HandoffRow | null,
): Response | null {
  if (!row?.cancel_requested_at) return null;
  if (row.status !== "approved" && row.status !== "redirected") return null;
  const after = failAsCancelled(services, row.handoff_id);
  return json(
    {
      error: {
        code: "cancel_requested",
        message: `handoff ${row.handoff_id} was cancelled before it was claimed`,
      },
      current_status: after?.status ?? null,
    },
    409,
  );
}
