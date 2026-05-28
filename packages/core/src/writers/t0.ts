import { Database } from "bun:sqlite";
import type { T0Event } from "../schemas/event.js";

export class T0Writer {
  private readonly insert;

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
    `);
  }

  write(e: T0Event): void {
    this.insert.run(
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
    );
  }
}
