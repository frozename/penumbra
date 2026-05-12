import { z } from 'zod';
import type { Services } from '@penumbra/core';
import { json } from './_helpers.js';

/**
 * POST /worker/heartbeat
 * Invoked by workers every ~15s to maintain liveness.
 */
export async function workerHeartbeatRoute(req: Request, services: Services): Promise<Response> {
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

  // Update liveness timestamp for this worker
  services.watchdog.recordHeartbeat(body.data.worker_id);
  services.dispatchEventLog.record({
    handoff_id: '',
    worker_id: body.data.worker_id,
    source: 'daemon',
    kind: 'heartbeat.received',
    ts: new Date().toISOString(),
  });

  return json({ ok: true });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

