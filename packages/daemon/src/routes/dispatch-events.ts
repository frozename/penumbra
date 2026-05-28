import { z } from "zod";
import type {
  DispatchEvent,
  DispatchEventInput,
  DispatchEventKind,
  Services,
} from "@penumbra/core";

import { json } from "./_helpers.js";
const KIND_VALUES = [
  "dispatch.start",
  "dispatch.end",
  "acp.server.start",
  "acp.session.start",
  "acp.session.end",
  "http.server.start",
  "http.session.start",
  "http.session.end",
  "proc.spawn",
  "proc.kill.sent",
  "proc.exited.resolved",
  "cancel.received",
  "cancel.dispatched",
  "heartbeat.sent",
  "heartbeat.received",
  "watchdog.tick",
  "watchdog.auto_fail",
  "claim",
  "agent.thought",
  "agent.thought.overflow",
  "agent.thought.digest",
  "agent.thought.signal",
  "agent.tool_call.failed",
  "extra_worker_wedge_evicted",
  "shell.session.open",
  "shell.run",
  "shell.session.close",
  "worker.recovery.requeued",
  "worker.recovery.exhausted",
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

export async function dispatchEventsGetRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const handoff_id = url.searchParams.get("handoff_id");
  if (!handoff_id) return json({ error: "missing_handoff_id" }, 400);

  const events = services.dispatchEventLog.listByHandoff(handoff_id).map((row) => ({
    handoff_id: row.handoff_id,
    worker_id: row.worker_id,
    source: row.source,
    kind: row.kind,
    ts: row.ts,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
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

export async function dispatchEventsStreamRoute(
  req: Request,
  services: Services,
): Promise<Response> {
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

  const bus = services.dispatchEvents;

  let shutdown: (() => Promise<void>) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const iterator = bus.subscribe(predicate);
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const write = (line: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(line));
          return true;
        } catch {
          return false;
        }
      };

      const close = async () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        try {
          await iterator.return?.();
        } catch {
          /* noop */
        }
      };
      shutdown = close;

      if (query.data.since !== undefined) {
        const sinceIso = new Date(query.data.since).toISOString();
        const replay = services.db
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
        for (const event of replay) {
          if (!write(`data: ${JSON.stringify(event)}\n\n`)) {
            void close();
            return;
          }
        }
      }

      write(": ok\n\n");

      void (async () => {
        try {
          for await (const event of iterator) {
            if (!write(`data: ${JSON.stringify(event)}\n\n`)) break;
          }
        } finally {
          await close();
        }
      })();

      keepalive = setInterval(() => {
        if (!write(": keepalive\n\n")) {
          void close();
        }
      }, 30_000);
    },
    cancel() {
      if (shutdown) {
        void shutdown();
      }
      shutdown = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
