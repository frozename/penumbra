import type { Services } from "@penumbra/core";

import { z } from "zod";

import type { OrphanHandoffRecoveryService } from "../services/orphan-handoff-recovery.js";

import { requireWorkerPrincipalMatch } from "../auth.js";
import { releaseSweptDrainHolds } from "../services/provider-concurrency.js";
import { json } from "./_helpers.js";

/**
 * POST /worker/reconcile-orphans
 * Triggered by workers on boot to recover dispatches orphaned by crashed workers.
 */
export async function workerReconcileOrphansRoute(
  req: Request,
  services: Services,
  recovery: OrphanHandoffRecoveryService,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }

  // claimed_before bounds reconciliation to rows claimed strictly before it
  // (last_dispatch_started_at). Unknown keys are rejected: a worker-side typo
  // must fail closed rather than silently run an unbounded reconcile.
  const body = z
    .object({
      worker_id: z.string().min(1),
      claimed_before: z.iso.datetime({ offset: true }).optional(),
    })
    .strict()
    .safeParse(raw);
  if (!body.success) {
    return json(
      {
        error: {
          code: "validation_error",
          message: "body failed schema validation",
          field_errors: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  const authErr = requireWorkerPrincipalMatch(req, body.data.worker_id);
  if (authErr) return authErr;

  try {
    // Normalize to the canonical ISO form claimDispatch stamps so the
    // lexicographic column comparison is exact even for offset inputs.
    const claimedBefore =
      body.data.claimed_before !== undefined
        ? new Date(body.data.claimed_before).toISOString()
        : undefined;
    const result = recovery.runOnce(body.data.worker_id, {
      workerKnownDead: true,
      claimedBefore,
    });
    if (claimedBefore !== undefined) {
      releaseDrainHolds(services, body.data.worker_id, claimedBefore);
    }
    return json({
      requeued: result.requeued,
      exhausted: result.exhausted,
      requeuedRowIds: result.requeuedRowIds,
      exhaustedRowIds: result.exhaustedRowIds,
    });
  } catch (err) {
    services.log.error(
      { err, worker_id: body.data.worker_id },
      "worker reconcile orphan recovery failed",
    );
    return json(
      {
        error: { code: "recovery_failed" },
      },
      500,
    );
  }
}

// The orphan recovery above already ran, so a failed release must not turn the reply into
// recovery_failed; the hold then ends at STALE_SWEEP_DRAIN_MAX_HOLD_MS instead.
function releaseDrainHolds(services: Services, worker_id: string, claimedBefore: string): void {
  try {
    releaseSweptDrainHolds(services, worker_id, claimedBefore);
  } catch (err) {
    services.log.warn({ err, worker_id }, "worker reconcile drain-hold release failed");
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
