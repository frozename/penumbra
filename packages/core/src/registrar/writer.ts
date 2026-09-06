// registrar_phases is a mutable projection; appendEvent is its only write path after creation.
import type { Database } from "bun:sqlite";

import {
  InvalidEntryTransition,
  InvalidPhaseTransition,
  PhaseNotFound,
  RegistrarNotFound,
  RegistrarSlugTaken,
  UnknownJournalRef,
} from "./errors.js";
import {
  type RegistrarCreateRequest,
  RegistrarCreateRequestSchema,
  type RegistrarEntry,
  RegistrarEntrySchema,
  type RegistrarEvent,
  RegistrarEventInputSchema,
  RegistrarEventSchema,
} from "./schema.js";

type RegistrarEntryRow = Omit<RegistrarEntry, "status"> & { status: string };

export function rethrowSlugUniqueConstraint(error: unknown, slug: string): never {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.includes("UNIQUE constraint failed: registrar_entries.slug")
  ) {
    throw new RegistrarSlugTaken(slug);
  }
  throw error;
}

export class RegistrarWriter {
  private readonly nowFn: () => number;

  constructor(
    private readonly db: Database,
    now: () => number = () => Date.now(),
  ) {
    this.nowFn = now;
  }

  createEntry(input: unknown): RegistrarEntry {
    const validated = RegistrarCreateRequestSchema.parse(input);
    return this.db.transaction(() => {
      const existing = this.db
        .query<
          { registrar_id: string },
          [string]
        >("SELECT registrar_id FROM registrar_entries WHERE slug = ?")
        .get(validated.slug);
      if (existing) throw new RegistrarSlugTaken(validated.slug);

      const registrar_id = crypto.randomUUID();
      const now = this.nowFn();
      try {
        this.insertEntry(registrar_id, validated, now);
      } catch (error) {
        rethrowSlugUniqueConstraint(error, validated.slug);
      }

      const insertPhase = this.db.query<unknown, [string, number, string, string, number]>(
        `INSERT INTO registrar_phases (registrar_id, phase_no, title, status, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [index, title] of validated.phases.entries()) {
        insertPhase.run(registrar_id, index + 1, title, index === 0 ? "active" : "pending", now);
      }

      return this.requireEntry(registrar_id);
    })();
  }

  appendEvent(registrar_id: string, input: unknown): RegistrarEvent {
    const validated = RegistrarEventInputSchema.parse(input);
    return this.db.transaction(() => {
      const entry = this.requireEntry(registrar_id);
      const phase_no = "phase_no" in validated ? validated.phase_no : undefined;
      const ref_event_id = "ref_event_id" in validated ? (validated.ref_event_id ?? null) : null;
      this.validatePhaseReference(registrar_id, phase_no);
      this.validateEventReference(registrar_id, ref_event_id);

      const now = this.nowFn();
      // Transitions mutate their projection row before journaling; the surrounding transaction
      // keeps both steps atomic and rolls the mutation back if the event insert fails.
      if (validated.kind === "phase_transition") {
        const result = this.db
          .query<unknown, [string, number, string, number, string]>(
            `UPDATE registrar_phases
             SET status = ?, updated_at = ?
             WHERE registrar_id = ? AND phase_no = ? AND status = ?`,
          )
          .run(validated.state, now, registrar_id, validated.phase_no, validated.from_status);
        if (result.changes === 0) {
          throw new InvalidPhaseTransition(registrar_id, validated.phase_no, validated.from_status);
        }
      }

      if (validated.kind === "entry_transition") {
        const result = this.db
          .query<unknown, [string, number, string, string]>(
            `UPDATE registrar_entries
             SET status = ?, updated_at = ?
             WHERE registrar_id = ? AND status = ?`,
          )
          .run(validated.state, now, registrar_id, validated.from_status);
        if (result.changes === 0) {
          throw new InvalidEntryTransition(registrar_id, validated.from_status, entry.status);
        }
      }

      const state = "state" in validated ? validated.state : null;
      const link_kind = "link_kind" in validated ? (validated.link_kind ?? null) : null;
      const link_value = "link_value" in validated ? (validated.link_value ?? null) : null;
      const inserted = this.db
        .query<
          unknown,
          [
            string,
            number | null,
            string,
            string | null,
            number | null,
            string | null,
            string | null,
            string,
            string,
            number,
          ]
        >(
          `INSERT INTO registrar_events
             (registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          registrar_id,
          phase_no ?? null,
          validated.kind,
          state,
          ref_event_id,
          link_kind,
          link_value,
          validated.actor,
          validated.body,
          now,
        );
      this.db
        .query<
          unknown,
          [number, string]
        >("UPDATE registrar_entries SET updated_at = ? WHERE registrar_id = ?")
        .run(now, registrar_id);

      const event_id = Number(inserted.lastInsertRowid);
      const row = this.db
        .query<Record<string, unknown> | null, [number]>(
          `SELECT event_id, registrar_id, phase_no, kind, state, ref_event_id, link_kind,
                  link_value, actor, body, created_at
           FROM registrar_events
           WHERE event_id = ?`,
        )
        .get(event_id);
      return RegistrarEventSchema.parse(row);
    })();
  }

  private validatePhaseReference(registrar_id: string, phase_no: number | undefined): void {
    if (phase_no === undefined) return;
    const phase = this.db
      .query<
        { phase_no: number },
        [string, number]
      >("SELECT phase_no FROM registrar_phases WHERE registrar_id = ? AND phase_no = ?")
      .get(registrar_id, phase_no);
    if (!phase) throw new PhaseNotFound(registrar_id, phase_no);
  }

  private validateEventReference(registrar_id: string, ref_event_id: number | null): void {
    if (ref_event_id === null) return;
    const referenced = this.db
      .query<
        { event_id: number },
        [number, string]
      >("SELECT event_id FROM registrar_events WHERE event_id = ? AND registrar_id = ?")
      .get(ref_event_id, registrar_id);
    if (!referenced) throw new UnknownJournalRef(registrar_id, ref_event_id);
  }

  private insertEntry(registrar_id: string, input: RegistrarCreateRequest, now: number): void {
    this.db
      .query<unknown, [string, string, string, string, string | null, string, number, number]>(
        `INSERT INTO registrar_entries
           (registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        registrar_id,
        input.slug,
        input.title,
        input.home_project,
        input.source_doc_path ?? null,
        input.status,
        now,
        now,
      );
  }

  private requireEntry(registrar_id: string): RegistrarEntry {
    const row = this.db
      .query<RegistrarEntryRow | null, [string]>(
        `SELECT registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at
         FROM registrar_entries
         WHERE registrar_id = ?`,
      )
      .get(registrar_id);
    if (!row) throw new RegistrarNotFound(registrar_id);
    return RegistrarEntrySchema.parse(row);
  }
}
