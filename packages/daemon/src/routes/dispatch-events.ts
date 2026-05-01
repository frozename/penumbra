import { z } from 'zod';
import type { Services } from '@penumbra/core';

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
] as const;

const DispatchEventKindSchema = z.enum(KIND_VALUES);
const DispatchEventSourceSchema = z.enum(['worker', 'daemon'] as const);

const DispatchEventSchema = z.object({
  handoff_id: z.string().min(1),
  worker_id: z.string().min(1).optional().nullable(),
  source: DispatchEventSourceSchema,
  kind: DispatchEventKindSchema,
  ts: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const DispatchEventsBatchSchema = z.object({
  events: z.array(DispatchEventSchema).min(1).max(50),
});

type DispatchEventInput = z.infer<typeof DispatchEventSchema>;

type DispatchEventRow = {
  handoff_id: string;
  worker_id: string | null;
  source: 'worker' | 'daemon';
  kind: DispatchEventInput['kind'];
  ts: string;
  meta_json: string | null;
};

interface DispatchEventLog {
  recordBatch(events: DispatchEventInput[]): void;
  listByHandoff(handoff_id: string): DispatchEventRow[];
}

type DispatchEventServices = Services & { dispatchEventLog: DispatchEventLog };

export async function dispatchEventsPostRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json({ error: 'invalid_json' }, 400);
  }

  const parsed = DispatchEventsBatchSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'invalid_payload', issues: parsed.error.issues }, 400);
  }

  (services as DispatchEventServices).dispatchEventLog.recordBatch(parsed.data.events);

  return json({ recorded: parsed.data.events.length });
}

export async function dispatchEventsGetRoute(req: Request, services: Services): Promise<Response> {
  const handoff_id = new URL(req.url).searchParams.get('handoff_id');
  if (!handoff_id) {
    return json({ error: 'missing_handoff_id' }, 400);
  }

  const rows = (services as DispatchEventServices).dispatchEventLog.listByHandoff(handoff_id);
  const events = rows.map((row) => ({
    handoff_id: row.handoff_id,
    worker_id: row.worker_id,
    source: row.source,
    kind: row.kind,
    ts: row.ts,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
  }));

  return json({ events });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
