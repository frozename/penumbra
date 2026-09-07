import type { Database } from "bun:sqlite";

import {
  type RegistrarEntry,
  RegistrarEntrySchema,
  type RegistrarEvent,
  RegistrarEventSchema,
  type RegistrarPhase,
  RegistrarPhaseSchema,
  type RegistrarRollup,
  RegistrarRollupSchema,
  type RegistrarStatus,
} from "./schema.js";

type RegistrarEntryRow = Omit<RegistrarEntry, "status"> & { status: string };
type RegistrarPhaseRow = Omit<RegistrarPhase, "status"> & { status: string };
type RegistrarEventRow = Omit<RegistrarEvent, "kind" | "state" | "link_kind" | "actor"> & {
  kind: string;
  state: string | null;
  link_kind: string | null;
  actor: string;
};

export class RegistrarReader {
  constructor(private readonly db: Database) {}

  getEntry(registrar_id: string): RegistrarEntry | undefined {
    const row = this.db
      .query<RegistrarEntryRow | null, [string]>(
        `SELECT registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at
         FROM registrar_entries
         WHERE registrar_id = ?`,
      )
      .get(registrar_id);
    return row ? RegistrarEntrySchema.parse(row) : undefined;
  }

  listEntries(opts?: { status?: RegistrarStatus }): RegistrarEntry[] {
    const rows = opts?.status
      ? this.db
          .query<RegistrarEntryRow, [string]>(
            `SELECT registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at
             FROM registrar_entries
             WHERE status = ?
             ORDER BY updated_at DESC, registrar_id ASC`,
          )
          .all(opts.status)
      : this.db
          .query<RegistrarEntryRow, []>(
            `SELECT registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at
             FROM registrar_entries
             ORDER BY updated_at DESC, registrar_id ASC`,
          )
          .all();
    const entries = rows.map((row) => RegistrarEntrySchema.parse(row));
    return entries.map((entry) => ({ ...entry, rollup: this.getRollup(entry.registrar_id) }));
  }

  listPhases(registrar_id: string): RegistrarPhase[] {
    const rows = this.db
      .query<RegistrarPhaseRow, [string]>(
        `SELECT registrar_id, phase_no, title, status, updated_at
         FROM registrar_phases
         WHERE registrar_id = ?
         ORDER BY phase_no ASC`,
      )
      .all(registrar_id);
    return rows.map((row) => RegistrarPhaseSchema.parse(row));
  }

  listEvents(registrar_id: string): RegistrarEvent[] {
    const rows = this.db
      .query<RegistrarEventRow, [string]>(
        `SELECT event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind,
                link_value, actor, body, created_at
         FROM registrar_events
         WHERE registrar_id = ?
         ORDER BY created_at ASC, event_id ASC`,
      )
      .all(registrar_id);
    return rows.map((row) => RegistrarEventSchema.parse(row));
  }

  getRollup(registrar_id: string): RegistrarRollup {
    const row = this.db
      .query<{ open_blockers: number; open_follow_ups: number }, [string, string]>(
        `SELECT
           SUM(CASE WHEN opened.kind = 'blocker' AND opened.state = 'opened' THEN 1 ELSE 0 END)
             AS open_blockers,
           SUM(CASE WHEN opened.kind = 'follow_up' AND opened.state = 'owed' THEN 1 ELSE 0 END)
             AS open_follow_ups
         FROM registrar_events AS opened
         WHERE opened.registrar_id = ?
           AND opened.state IN ('opened', 'owed')
           AND NOT EXISTS (
             SELECT 1
             FROM registrar_events AS closed
             WHERE closed.registrar_id = ?
               AND closed.kind = opened.kind
               AND closed.ref_event_id = opened.event_id
               AND closed.state IN ('resolved', 'done', 'dropped')
           )`,
      )
      .get(registrar_id, registrar_id);
    return RegistrarRollupSchema.parse({
      open_blockers: row?.open_blockers ?? 0,
      open_follow_ups: row?.open_follow_ups ?? 0,
    });
  }
}
