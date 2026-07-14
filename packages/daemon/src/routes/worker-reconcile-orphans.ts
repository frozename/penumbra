import type { Services } from "@penumbra/core";

import { z } from "zod";

import type { OrphanHandoffRecoveryService } from "../services/orphan-handoff-recovery.js";

import { requireWorkerPrincipalMatch } from "../auth.js";
import { json } from "./_helpers.js";

/**
 * POST /worker/reconcile-orphans
 * Triggered by workers on boot to recover dispatches orphaned by crashed workers.
 */
export async function workerReconcileOrphansRoute(
  req: Request,
  _services: Services,
  recovery: OrphanHandoffRecoveryService,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json(
      { error: { code: "invalid_json", message: "request body was not valid JSON" } },
      400,
    );
  }

  const body = z.object({ worker_id: z.string().min(1) }).safeParse(raw);
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
    const result = recovery.runOnce(body.data.worker_id, { workerKnownDead: true });
    return json({
      requeued: result.requeued,
      exhausted: result.exhausted,
      requeuedRowIds: result.requeuedRowIds,
      exhaustedRowIds: result.exhaustedRowIds,
    });
  } catch (err) {
    _services.log.error(
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

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
