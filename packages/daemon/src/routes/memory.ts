import { z } from 'zod';
import type { Services } from '@penumbra/core';
import {
  SearchRequestSchema,
  TimelineRequestSchema,
  GetObservationsRequestSchema,
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
} from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  const parsed = z.object({ memory_id: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return validationError(parsed);
  const result = verifyMemory(services.db, parsed.data.memory_id);
  if (!result) return json({ error: 'memory_not_found' }, 404);
  return json(result);
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
