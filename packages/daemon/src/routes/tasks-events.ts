import { z } from 'zod';
import type { Services } from '@penumbra/core';
import type { TaskEvent } from '@penumbra/core';
import { TaskEventBus, TaskEventKindSchema } from '@penumbra/core';
import { json } from './_helpers.js';
interface TaskEventDbRow {
  task_id: string;
  at: number;
  kind: string;
  actor: string | null;
  payload_json: string | null;
}

const TaskEventsQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  agent: z.string().min(1).optional(),
}).strict();

function invalidInput(details: unknown): Response {
  return json({ error: 'invalid_input', details }, 400);
}

function parseKindFilter(raw: string | null): Set<string> | Response | null {
  if (!raw) return null;
  const parsed = z.array(TaskEventKindSchema).min(1).safeParse(
    raw.split(',').map((item) => item.trim()).filter(Boolean),
  );
  if (!parsed.success) return invalidInput(parsed.error.issues);
  return new Set(parsed.data);
}

function hydrateTaskEvent(row: TaskEventDbRow): TaskEvent {
  return {
    task_id: row.task_id,
    at: row.at,
    kind: TaskEventKindSchema.parse(row.kind),
    actor: row.actor,
    payload: row.payload_json ? JSON.parse(row.payload_json) as Record<string, unknown> : null,
  };
}

export async function tasksEventsRoute(req: Request, services: Services, bus: TaskEventBus): Promise<Response> {
  const url = new URL(req.url);
  const query = TaskEventsQuerySchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
    agent: url.searchParams.get('agent') ?? undefined,
  });
  if (!query.success) return invalidInput(query.error.issues);

  const kindFilter = parseKindFilter(url.searchParams.get('kind'));
  if (kindFilter instanceof Response) return kindFilter;

  const predicate = (event: TaskEvent): boolean => {
    if (kindFilter && !kindFilter.has(event.kind)) return false;
    if (query.data.agent && event.actor !== query.data.agent) return false;
    return true;
  };

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
        const replay = services.db
          .query<TaskEventDbRow, [number]>(
            `SELECT task_id, at, kind, actor, payload_json
             FROM task_events
             WHERE at >= ?
             ORDER BY at ASC, id ASC
             LIMIT 200`,
          )
          .all(query.data.since)
          .map(hydrateTaskEvent)
          .filter(predicate);
        for (const event of replay) {
          if (!write(`data: ${JSON.stringify(event)}\n\n`)) {
            void close();
            return;
          }
        }
      }

      write(': ok\n\n');

      void (async () => {
        try {
          for await (const event of iterator) {
            if (!write(`data: ${JSON.stringify(event)}\n\n`)) {
              break;
            }
          }
        } finally {
          await close();
        }
      })();

      keepalive = setInterval(() => {
        if (!write(': keepalive\n\n')) {
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
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
