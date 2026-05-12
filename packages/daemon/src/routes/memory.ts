import { z } from 'zod';
import type { Services } from '@penumbra/core';
import {
  SearchRequestSchema,
  TimelineRequestSchema,
  GetObservationsRequestSchema,
  getMemoryVerificationEvents,
  CorpusBuildRequestSchema,
  CorpusQueryRequestSchema,
  search,
  timeline,
  getObservations,
  buildCorpus,
  queryCorpus,
  listCorpora,
  recallStatus,
  verifyMemory,
  getMemoryEfficacyRecent,
  enqueueMemoryEfficacyJob,
  getJobStatus,
  listRecentJobs,
} from '@penumbra/core';

async function readJson(req: Request): Promise<unknown | { _err: Response }> {
  try {
    return await req.json();
  } catch {
    return {
      _err: json(
        { error: { code: 'invalid_json', message: 'request body was not valid JSON' } },
        400,
      ),
    };
  }
}

import { json } from './_helpers.js';
export const EFFICACY_RUNNER_HEARTBEAT_STALE_MS = 60_000;
function validationError(parsed: { error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } }): Response {
  return json(
    {
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({
          path: i.path.map((p) => (typeof p === 'symbol' ? p.toString() : p)),
          message: i.message,
        })),
      },
    },
    400,
  );
}

export async function memorySearchRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = SearchRequestSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  const hits = search(services.db, parsed.data);
  return json({ hits });
}

export async function memoryVerifyRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = z.object({
    memory_id: z.string().min(1),
    claimed_by: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:@-]+$/).optional(),
    by: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:@-]+$/).describe('Deprecated: use claimed_by instead').optional(),
    reason: z.string().min(1).max(500).optional(),
    session_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/).optional(),
  }).safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  // Keep the legacy alias wired for callers that still send `by`.
  const claimedBy = parsed.data.claimed_by ?? parsed.data.by ?? null;
  const verifierActor = services.machineId.get();
  const eventId = services.uuid();
  const result = verifyMemory(services.db, parsed.data.memory_id, {
    verifierActor,
    claimedBy: claimedBy ?? undefined,
    reason: parsed.data.reason,
    sessionId: parsed.data.session_id,
    uuid: () => eventId,
  });
  if (!result) return json({ error: 'memory_not_found' }, 404);
  return json({
    memory_id: result.memory_id,
    last_verified_at: result.last_verified_at,
    last_verified_by: result.last_verified_by,
    last_verified_actor: result.last_verified_actor,
    last_verified_reason: result.last_verified_reason,
    last_verified_session_id: result.last_verified_session_id,
    verifier_actor: verifierActor,
    claimed_by: claimedBy,
    event_id: result.event_id,
  });
}

export async function memoryVerificationEventsRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/');
  const memoryId = parts[2];
  if (parts.length !== 4 || parts[1] !== 'memory' || parts[3] !== 'verification_events' || !memoryId) {
    return json({ error: 'not_found' }, 404);
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limitRaw !== null && (!Number.isInteger(limit) || !Number.isFinite(limit))) {
    return json({ error: 'invalid_limit' }, 400);
  }
  const events = getMemoryVerificationEvents(services.db, memoryId, limit);
  return json({ events });
}

export async function memoryTimelineRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = TimelineRequestSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  const entries = timeline(services.db, parsed.data);
  return json({ entries });
}

export async function memoryGetRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = GetObservationsRequestSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  const observations = getObservations(services.db, parsed.data);
  return json({ observations });
}

export async function memoryCorpusBuildRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = CorpusBuildRequestSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  const summary = await buildCorpus(services.db, services.embedder, parsed.data);
  return json(summary);
}

export async function memoryCorpusQueryRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = CorpusQueryRequestSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  const hits = await queryCorpus(services.db, services.embedder, parsed.data);
  return json({ hits });
}

export async function memoryCorpusListRoute(_req: Request, services: Services): Promise<Response> {
  const corpora = listCorpora(services.db);
  return json({ corpora });
}

export async function memoryStatusRoute(_req: Request, services: Services): Promise<Response> {
  return json(recallStatus(services.db));
}

const EfficacyRecentSchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include_raw: z.boolean().optional(),
});

export async function memoryEfficacyRecentRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = EfficacyRecentSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  return json(
    getMemoryEfficacyRecent(services.db, {
      sinceISO: parsed.data.since,
      limit: parsed.data.limit,
      includeRaw: parsed.data.include_raw,
    }),
  );
}

const EfficacyRebuildSchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  source: z.enum(['maestro', 'cli', 'http']).optional(),
});

export async function memoryEfficacyRebuildRoute(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = EfficacyRebuildSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  // Async v2: enqueue only when a live runner is available to drain the queue.
  const runnerHeartbeatAt = services.memoryEfficacyRunnerHeartbeatAt ?? 0;
  if (Date.now() - runnerHeartbeatAt > EFFICACY_RUNNER_HEARTBEAT_STALE_MS) {
    return json(
      { error: { code: 'backend_unavailable', message: 'no live job runner' } },
      503,
    );
  }

  const reviewsDir = `${services.storageRoot}/../.penumbra/reviews`;

  const enqueued = enqueueMemoryEfficacyJob(services.db, {
    reviewsDir,
    sinceISO: parsed.data.since,
    enqueuedBy: parsed.data.source ?? 'http',
  });

  return json({ job_id: enqueued.job_id, status: 'queued' }, 202);
}

export async function memoryEfficacyJobRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const jobId = url.pathname.split('/').pop();
  if (!jobId) return json({ error: 'job_id_required' }, 400);
  const status = getJobStatus(services.db, jobId);
  if (!status) return json({ error: 'job_not_found' }, 404);
  return json(status);
}

export async function memoryEfficacyJobsRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const limit = url.searchParams.get('limit');
  const status = url.searchParams.get('status');
  const jobs = listRecentJobs(services.db, {
    limit: limit ? parseInt(limit, 10) : undefined,
    status: status ?? undefined,
  });
  return json({ jobs });
}
