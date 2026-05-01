import { z } from 'zod';
import type { DispatchEventInput, DispatchEventKind, Services } from '@penumbra/core';

const KIND_VALUES = [
  'dispatch.start',
  'dispatch.end',
  'proc.spawn',
  'proc.kill.sent',
  'proc.exited.resolved',
  'cancel.received',
  'cancel.dispatched',
  'heartbeat.sent',
  'heartbeat.received',
  'watchdog.tick',
  'watchdog.auto_fail',
] as const satisfies readonly DispatchEventKind[];

const EventSchema = z.object({
  handoff_id: z.string(),
  worker_id: z.string().nullish(),
  source: z.enum(['worker', 'daemon']),
  kind: z.enum(KIND_VALUES),
  ts: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const BatchSchema = z.object({
  events: z.array(EventSchema).min(1).max(50),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function dispatchEventsPostRoute(req: Request, services: Services): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'invalid_payload', issues: parsed.error.issues }, 400);
  }

  services.dispatchEventLog.recordBatch(parsed.data.events as DispatchEventInput[]);
  return json({ recorded: parsed.data.events.length });
}

export async function dispatchEventsGetRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const handoff_id = url.searchParams.get('handoff_id');
  if (!handoff_id) return json({ error: 'missing_handoff_id' }, 400);

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
