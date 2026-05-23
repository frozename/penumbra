import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Services } from '@penumbra/core';
import {
  parseWikiLinks,
  writeDirectT2Memory,
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
import { getPrincipal } from '../auth.js';
import { json } from './_helpers.js';

const DIRECT_WRITE_CYCLE_ID = 'direct-write';

function ensureDirectWriteCycleId(db: Services['db']): string {
  const existing = db
    .prepare(`SELECT cycle_id FROM dream_cycles WHERE cycle_id = ?`)
    .get(DIRECT_WRITE_CYCLE_ID) as { cycle_id: string } | undefined;
  if (existing?.cycle_id) return DIRECT_WRITE_CYCLE_ID;

  db.prepare(`
    INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
    VALUES(?, ?, 'direct-write', 0, 'completed', '[]')
  `).run(DIRECT_WRITE_CYCLE_ID, Date.now());
  return DIRECT_WRITE_CYCLE_ID;
}

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

const MemoryWriteT2Schema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  slug: z.string().optional().nullable(),
  hook: z.string().optional().nullable(),
  sub_kind: z.string().optional().nullable(),
  cc_kind: z.string().optional().nullable(),
  project_id: z.string().nullable().optional(),
}).strict();

export async function memoryWriteT2Route(req: Request, services: Services): Promise<Response> {
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && '_err' in raw) return (raw as { _err: Response })._err;
  const parsed = MemoryWriteT2Schema.safeParse(raw);
  if (!parsed.success) return validationError(parsed);

  const principal = getPrincipal(req);
  if (principal?.kind !== 'shared') {
    return json(
      {
        error: {
          code: 'caller_not_authorized',
          message: 'direct-write is restricted to shared-bearer principals; worker-token callers are not authorized',
        },
      },
      403,
    );
  }

  const data = parsed.data;
  const embedding = (await services.embedder.embed([data.body]))[0];
  if (embedding == null) {
    return json({ error: { code: 'embed_failed', message: 'embedding returned no vector' } }, 500);
  }

  const result = services.db.transaction(() => {
    const directCycleId = ensureDirectWriteCycleId(services.db);
    const wrote = writeDirectT2Memory(services.db, {
      title: data.title,
      body: data.body,
      slug: data.slug,
      hook: data.hook,
      sub_kind: data.sub_kind,
      cc_kind: data.cc_kind,
      project_id: data.project_id,
      embedding,
    });

    const parsedLinks = parseWikiLinks(data.body);
    if (!wrote.created) {
      services.db.prepare(
        `DELETE FROM memory_links WHERE src_id = ? AND link_type IN ('wiki', 'wiki_unresolved')`,
      ).run(wrote.memory_id);
    }
    if (parsedLinks.length > 0) {
      const now = Date.now();
      const resolveSlug = services.db
        .prepare(`SELECT memory_id FROM t2_memories WHERE slug = ? AND retired_at IS NULL`);
      const upsertResolvedLink = services.db.prepare(`
        INSERT OR IGNORE INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
        VALUES(?, ?, ?, 'wiki', 1.0, ?, ?)
      `);
      const upsertUnresolvedLink = services.db.prepare(`
        INSERT OR IGNORE INTO memory_links(
          link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle, metadata_json, raw_slug
        ) VALUES(?, ?, NULL, 'wiki_unresolved', 1.0, ?, ?, ?, ?)
      `);

      for (const slug of parsedLinks) {
        const linked = resolveSlug.get(slug) as { memory_id: string } | undefined;
        if (linked?.memory_id) {
          upsertResolvedLink.run(randomUUID(), wrote.memory_id, linked.memory_id, now, directCycleId);
        } else {
          upsertUnresolvedLink.run(
            randomUUID(),
            wrote.memory_id,
            now,
            directCycleId,
            slug,
            JSON.stringify({ raw_slug: slug }),
          );
        }
      }
    }

    return wrote;
  })();

  return json(result);
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

  const reviewsDir = services.reviewsDir;

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
