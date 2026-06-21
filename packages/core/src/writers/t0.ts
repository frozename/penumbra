import { Database } from "bun:sqlite";

import type { T0Event } from "../schemas/event.js";

export class T0Writer {
  private readonly insert;
  private readonly selectEventId;

  constructor(db: Database) {
    this.insert = db.prepare(`
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, source_detail, project_id,
        user_id, machine_id, session_id, event_type, lane,
        provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary, origin
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(event_id) DO NOTHING
      RETURNING event_id
    `);
    this.selectEventId = db.prepare(`SELECT event_id FROM t0_events WHERE event_id = ?`);
  }

  write(e: T0Event): string {
    const row = this.insert.get(
      e.event_id,
      e.ts,
      e.ingest_ts,
      e.source,
      e.source_detail,
      e.project_id,
      e.user_id,
      e.machine_id,
      e.session_id,
      e.event_type,
      e.lane,
      e.provider,
      e.model,
      e.tokens_in,
      e.tokens_out,
      e.cost_usd,
      e.latency_ms,
      e.request_id,
      JSON.stringify(e.payload_json),
      e.payload_summary,
      e.origin ?? null,
    ) as { event_id: string } | null;
    if (row) {
      return row.event_id;
    }

    console.warn("[t0-writer] duplicate event_id conflict resolved from existing row", {
      event_id: e.event_id,
      handoff_id: e.request_id ?? null,
      source: e.source,
    });
    const existing = this.selectEventId.get(e.event_id) as { event_id: string } | null;
    if (!existing) {
      throw new Error(`t0_events conflict resolution failed for event_id=${e.event_id}`);
    }
    return existing.event_id;
  }
}
