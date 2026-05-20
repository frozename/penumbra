import type { Database } from 'bun:sqlite';
import type { DispatchEventKind as ApiDispatchEventKind } from '@penumbra/api-contract';
import type { DispatchEventBus } from '../dispatch/event-bus.js';

// The API contract owns the shared wire-event union; core adds one internal-only lifecycle event.
export type DispatchEventKind = ApiDispatchEventKind | 'agent.heartbeat';

export interface DispatchEventInput {
  handoff_id: string;
  worker_id?: string | null;
  source: 'worker' | 'daemon';
  kind: DispatchEventKind;
  ts: string;
  meta?: Record<string, unknown>;
}

export interface DispatchEventRow {
  id: number;
  handoff_id: string;
  worker_id: string | null;
  source: 'worker' | 'daemon';
  kind: DispatchEventKind;
  ts: string;
  meta_json: string | null;
}

const MAX_META_JSON_LENGTH = 4096;
const STRICT_META_JSON_EVENT_KINDS: DispatchEventKind[] = ['dispatch.end'];

function normalizeEventMeta(kind: DispatchEventKind, meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  const rawJson = JSON.stringify(meta);
  if (rawJson.length <= MAX_META_JSON_LENGTH) return meta;

  if (STRICT_META_JSON_EVENT_KINDS.includes(kind)) {
    throw new Error(`dispatch_events.meta_json exceeds ${MAX_META_JSON_LENGTH} bytes for strict kind ${kind}`);
  }

  const truncatedMeta = {
    _truncated: true,
    kind,
    original_size: rawJson.length,
  };
  console.warn(`dispatch_events.meta_json truncated for ${kind} at ${rawJson.length} bytes`);
  return truncatedMeta;
}

export class DispatchEventLog {
  constructor(
    private readonly db: Database,
    private readonly bus?: DispatchEventBus,
  ) {}

  record(event: DispatchEventInput): void {
    const meta = normalizeEventMeta(event.kind, event.meta);
    this.db.run(
      `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.handoff_id,
        event.worker_id ?? null,
        event.source,
        event.kind,
        event.ts,
        meta === undefined ? null : JSON.stringify(meta),
      ],
    );
    this.bus?.publish({
      handoff_id: event.handoff_id,
      worker_id: event.worker_id ?? null,
      source: event.source,
      kind: event.kind,
      ts: event.ts,
      meta: meta ?? null,
    });
  }

  recordBatch(events: DispatchEventInput[]): void {
    if (events.length === 0) return;
    const tx = this.db.transaction((batch: DispatchEventInput[]) => {
      for (const event of batch) this.record(event);
    });
    tx(events);
  }

  listByHandoff(handoff_id: string): DispatchEventRow[] {
    return this.db
      .query('SELECT * FROM dispatch_events WHERE handoff_id = ? ORDER BY ts ASC, id ASC')
      .all(handoff_id) as DispatchEventRow[];
  }
}
