import { z } from 'zod';
import { WorkerTokenStore } from '@penumbra/core';
import { getPrincipal } from '../auth.js';

const bodySchema = z.object({
  worker_id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function workerRegisterRoute(
  req: Request,
  store: WorkerTokenStore,
): Promise<Response> {
  // Only shared-bearer callers can register. A worker presenting its own
  // token would be 200-authenticated by the middleware but must be rejected
  // here to prevent token chaining.
  const principal = getPrincipal(req);
  if (principal?.kind === 'worker') {
    return Response.json(
      { error: { code: 'shared_bearer_required_for_registration', message: 'worker tokens cannot mint other worker tokens' } },
      { status: 403 },
    );
  }

  const raw = await safeJson(req);
  if (raw === null) {
    return Response.json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: 'validation_error',
          message: 'body failed schema validation',
          field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      },
      { status: 400 },
    );
  }

  const MAX_METADATA_BYTES = 4096;
  if (parsed.data.metadata !== undefined && Buffer.byteLength(JSON.stringify(parsed.data.metadata), 'utf8') > MAX_METADATA_BYTES) {
    return Response.json(
      { error: { code: 'metadata_too_large', message: 'metadata must be at most 4096 bytes when JSON-stringified', limit: MAX_METADATA_BYTES } },
      { status: 400 },
    );
  }

  const now = Date.now();
  const { token } = store.issue(
    { worker_id: parsed.data.worker_id, metadata: parsed.data.metadata },
    now,
  );
  return Response.json({ worker_token: token, worker_id: parsed.data.worker_id });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
