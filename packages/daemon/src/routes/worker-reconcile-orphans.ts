import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { json } from './_helpers.js';
import type { OrphanHandoffRecoveryService } from '../services/orphan-handoff-recovery.js';

/**
 * POST /worker/reconcile-orphans
 * Triggered by workers on boot to recover dispatches orphaned by crashed workers.
 */
export async function workerReconcileOrphansRoute(
  req: Request,
  _services: Services,
  recovery: OrphanHandoffRecoveryService
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }

  const body = z.object({ worker_id: z.string().min(1) }).safeParse(raw);
  if (!body.success) {
    return json(
      {
        error: {
          code: 'validation_error',
          message: 'body failed schema validation',
          field_errors: body.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      400,
    );
  }

  try {
    const result = recovery.runOnce();
    return json(result);
  } catch (err) {
    return json(
      {
        error: {
          code: 'recovery_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      },
      500
    );
  }
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
