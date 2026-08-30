import type { Services, TaskEvent } from "@penumbra/core";

import { TaskEventBus, TaskEventKindSchema } from "@penumbra/core";
import { z } from "zod";

import { json } from "./_helpers.js";
import { sseIteratorStream } from "./_sse.js";

interface TaskEventDbRow {
  task_id: string;
  at: number;
  kind: string;
  actor: string | null;
  payload_json: string | null;
}

const TaskEventsQuerySchema = z
  .object({
    since: z.coerce.number().int().nonnegative().optional(),
    agent: z.string().min(1).optional(),
  })
  .strict();

function invalidInput(details: unknown): Response {
  return json({ error: "invalid_input", details }, 400);
}

function parseKindFilter(raw: string | null): Set<string> | Response | null {
  if (!raw) return null;
  const parsed = z
    .array(TaskEventKindSchema)
    .min(1)
    .safeParse(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
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
    payload: row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null,
  };
}

export function tasksEventsRoute(req: Request, services: Services, bus: TaskEventBus): Response {
  const url = new URL(req.url);
  const query = TaskEventsQuerySchema.safeParse({
    since: url.searchParams.get("since") ?? undefined,
    agent: url.searchParams.get("agent") ?? undefined,
  });
  if (!query.success) return invalidInput(query.error.issues);

  const kindFilter = parseKindFilter(url.searchParams.get("kind"));
  if (kindFilter instanceof Response) return kindFilter;

  const predicate = (event: TaskEvent): boolean => {
    if (kindFilter && !kindFilter.has(event.kind)) return false;
    if (query.data.agent && event.actor !== query.data.agent) return false;
    return true;
  };

  const since = query.data.since;
  return sseIteratorStream({
    subscribe: () => bus.subscribe(predicate),
    replay:
      since === undefined
        ? undefined
        : (): Iterable<TaskEvent> =>
            services.db
              .query<TaskEventDbRow, [number]>(
                `SELECT task_id, at, kind, actor, payload_json
                 FROM task_events
                 WHERE at >= ?
                 ORDER BY at ASC, id ASC
                 LIMIT 200`,
              )
              .all(since)
              .map(hydrateTaskEvent)
              .filter(predicate),
  });
}
