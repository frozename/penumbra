import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type { T0Event } from "../schemas/event.js";

export class T0Writer {
  private readonly insert;
  private readonly selectEventId;
  private readonly ensureRetirementTombstone;
  private readonly ensureLiveSnapshot;

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
    const latestSnapshot = db.prepare(`
      SELECT event_id, ts, payload_json, julianday(ts) AS j FROM t0_events
      WHERE event_type = 'rate-limit-snapshot' AND provider IS ?
        AND json_extract(payload_json, '$.window_label') IS ?
        AND COALESCE(json_extract(payload_json, '$.model'), '') = ?
      ORDER BY julianday(ts) DESC, rowid DESC LIMIT 1
    `);

    const eventTime = db.prepare("SELECT julianday(?) AS j");
    const laterTs = (latest: LatestSnapshot | null, event: T0Event): string => {
      if (!latest) return event.ts;
      const eventJ = (eventTime.get(event.ts) as { j: number | null }).j;
      return eventJ === null || (latest.j !== null && latest.j > eventJ) ? latest.ts : event.ts;
    };
    const readLatest = (group: SnapshotGroup): LatestSnapshot | null =>
      latestSnapshot.get(
        group.provider,
        group.window_label,
        group.model ?? "",
      ) as LatestSnapshot | null;
    this.ensureRetirementTombstone = db.transaction(
      (event: T0Event, group: SnapshotGroup): string => {
        const latest = readLatest(group);
        if (latest && isRetired(latest)) return latest.event_id;
        const eventId =
          "retirement-" +
          digest([
            "retirement",
            group.provider,
            group.window_label,
            group.model,
            latest?.event_id ?? null,
          ]);
        return this.insertEvent({ ...event, event_id: eventId, ts: laterTs(latest, event) });
      },
    );
    this.ensureLiveSnapshot = db.transaction((event: T0Event, group: SnapshotGroup): string => {
      const inserted = this.tryInsertEvent(event);
      if (inserted) return inserted;
      const latest = readLatest(group);
      if (latest && isRetired(latest)) {
        return this.insertEvent({
          ...event,
          event_id: "resurrection-" + digest([event.event_id, latest.event_id]),
          ts: laterTs(latest, event),
        });
      }
      return this.existingEventId(event);
    });
  }

  write(e: T0Event): string {
    const group = groupKeyOf(e);
    if (!group) return this.insertEvent(e);
    return e.payload_json.retired === true
      ? this.ensureRetirementTombstone.immediate(e, group)
      : this.ensureLiveSnapshot.immediate(e, group);
  }

  private tryInsertEvent(e: T0Event): string | null {
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
    return row?.event_id ?? null;
  }

  private insertEvent(e: T0Event): string {
    return this.tryInsertEvent(e) ?? this.existingEventId(e);
  }

  private existingEventId(e: T0Event): string {
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

type SnapshotGroup = { provider: string | null; window_label: string; model: string | null };
type LatestSnapshot = { event_id: string; ts: string; payload_json: string; j: number | null };

function groupKeyOf(event: T0Event): SnapshotGroup | null {
  const { window_label, model } = event.payload_json;
  if (event.event_type !== "rate-limit-snapshot" || typeof window_label !== "string") return null;
  if (model !== null && model !== undefined && typeof model !== "string") return null;
  return { provider: event.provider, window_label, model: model ?? null };
}
function isRetired(latest: LatestSnapshot | null): boolean {
  return (
    latest !== null && (JSON.parse(latest.payload_json) as { retired?: boolean }).retired === true
  );
}
function digest(identity: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
