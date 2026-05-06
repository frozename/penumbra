import type { Database } from 'bun:sqlite';

export type DispatchEventKind =
  | 'dispatch.start'
  | 'dispatch.end'
  | 'acp.server.start'
  | 'acp.session.start'
  | 'acp.session.end'
  | 'http.server.start'
  | 'http.session.start'
  | 'http.session.end'
  | 'proc.spawn'
  | 'proc.kill.sent'
  | 'proc.exited.resolved'
  | 'cancel.received'
  | 'cancel.dispatched'
  | 'heartbeat.sent'
  | 'heartbeat.received'
  | 'watchdog.tick'
  | 'watchdog.auto_fail'
  | 'claim'
  | 'agent.thought'
  | 'agent.thought.overflow'
  | 'agent.thought.digest'
  | 'agent.thought.signal'
  | 'agent.tool_call.failed'
  | 'shell.session.open'
  | 'shell.run'
  | 'shell.session.close';

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

export class DispatchEventLog {
  constructor(private readonly db: Database) {}

  record(event: DispatchEventInput): void {
    this.db.run(
      `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.handoff_id,
        event.worker_id ?? null,
        event.source,
        event.kind,
        event.ts,
        event.meta === undefined ? null : JSON.stringify(event.meta),
      ],
    );
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
