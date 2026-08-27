import type {
  DispatchEvent,
  DispatchEventInput,
  DispatchEventKind,
  Services,
} from "@penumbra/core";

import { DispatchEventKindSchema } from "@penumbra/api-contract";
import { z } from "zod";

import { json } from "./_helpers.js";
import { sseIteratorStream } from "./_sse.js";

// Every DispatchEventKind the POST route accepts and records. DERIVED from the
// api-contract schema (the single source of truth), with an explicit heartbeat
// guard for older package-level imports. The previous copy was hand-maintained
// and omitted "acp.session.reuse" and "agent.heartbeat": because BatchSchema
// below 400-rejects a whole batch on any unknown kind, every worker batch
// carrying those events was dropped at ingestion and never recorded. Adding a
// kind to the api-contract enum now auto-extends this list.
const KIND_VALUES = [
  ...DispatchEventKindSchema.options,
  "agent.heartbeat",
] as const satisfies readonly DispatchEventKind[];

const EventSchema = z.object({
  handoff_id: z.string(),
  worker_id: z.string().nullish(),
  source: z.enum(["worker", "daemon"]),
  kind: z.enum(KIND_VALUES),
  ts: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const BatchSchema = z.object({
  events: z.array(EventSchema).min(1).max(50),
});

export async function dispatchEventsPostRoute(req: Request, services: Services): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }

  services.dispatchEventLog.recordBatch(parsed.data.events as DispatchEventInput[]);
  return json({ recorded: parsed.data.events.length });
}

export function dispatchEventsGetRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const handoff_id = url.searchParams.get("handoff_id");
  if (!handoff_id) return json({ error: "missing_handoff_id" }, 400);

  const events = services.dispatchEventLog.listByHandoff(handoff_id).map((row) => ({
    handoff_id: row.handoff_id,
    worker_id: row.worker_id,
    source: row.source,
    kind: row.kind,
    ts: row.ts,
    meta: row.meta_json ? (JSON.parse(row.meta_json) as unknown) : null,
  }));
  return json({ events });
}

const StreamQuerySchema = z
  .object({
    since: z.coerce.number().int().nonnegative().optional(),
    handoff_id: z.string().min(1).optional(),
    source: z.enum(["worker", "daemon"]).optional(),
  })
  .strict();

interface DispatchEventDbRow {
  handoff_id: string;
  worker_id: string | null;
  source: "worker" | "daemon";
  kind: string;
  ts: string;
  meta_json: string | null;
}

function parseStreamKindFilter(raw: string | null): Set<DispatchEventKind> | Response | null {
  if (!raw) return null;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  const parsed = z.array(z.enum(KIND_VALUES)).min(1).safeParse(items);
  if (!parsed.success) {
    return json({ error: "invalid_input", details: parsed.error.issues }, 400);
  }
  return new Set(parsed.data);
}

function hydrateRow(row: DispatchEventDbRow): DispatchEvent {
  return {
    handoff_id: row.handoff_id,
    worker_id: row.worker_id,
    source: row.source,
    kind: row.kind as DispatchEventKind,
    ts: row.ts,
    meta: row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : null,
  };
}

export function dispatchEventsStreamRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const query = StreamQuerySchema.safeParse({
    since: url.searchParams.get("since") ?? undefined,
    handoff_id: url.searchParams.get("handoff_id") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
  });
  if (!query.success) return json({ error: "invalid_input", details: query.error.issues }, 400);

  const kindFilter = parseStreamKindFilter(url.searchParams.get("kind"));
  if (kindFilter instanceof Response) return kindFilter;

  const predicate = (event: DispatchEvent): boolean => {
    if (query.data.handoff_id && event.handoff_id !== query.data.handoff_id) return false;
    if (query.data.source && event.source !== query.data.source) return false;
    if (kindFilter && !kindFilter.has(event.kind)) return false;
    return true;
  };

  const since = query.data.since;
  return sseIteratorStream({
    subscribe: () => services.dispatchEvents.subscribe(predicate),
    replay:
      since === undefined
        ? undefined
        : (): Iterable<DispatchEvent> => {
            const sinceIso = new Date(since).toISOString();
            return services.db
              .query<DispatchEventDbRow, [string]>(
                `SELECT handoff_id, worker_id, source, kind, ts, meta_json
                 FROM dispatch_events
                 WHERE ts >= ?
                 ORDER BY ts ASC, id ASC
                 LIMIT 200`,
              )
              .all(sinceIso)
              .map(hydrateRow)
              .filter(predicate);
          },
  });
}
