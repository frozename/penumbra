import type { Database } from "bun:sqlite";

import { type RegistrarEntry, RegistrarReader, type RegistrarStatus } from "@penumbra/core";

export type RegistrarStatusRow = {
  registrar_id: string;
  slug: string;
  title: string;
  status: RegistrarStatus;
  phases: { phase_no: number; title: string; status: string }[];
  rollup: { open_blockers: number; open_follow_ups: number };
  last_event_id: number | null;
};

export type RegistrarStatusSourceOutput = {
  rows: RegistrarStatusRow[];
  warnings: string[];
};

function normalizeLimit(value: unknown): number {
  return Math.max(
    1,
    Math.min(50, typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 5),
  );
}

function normalizeStatus(value: unknown): RegistrarStatus | undefined {
  if (
    value === "draft" ||
    value === "active" ||
    value === "paused" ||
    value === "complete" ||
    value === "abandoned"
  ) {
    return value;
  }
  return undefined;
}

function isRegistrarEntry(value: RegistrarEntry | undefined): value is RegistrarEntry {
  return value !== undefined;
}

export function runRegistrarStatusSource(input: {
  db: Database;
  args?: Record<string, unknown>;
}): RegistrarStatusSourceOutput {
  try {
    const args = input.args ?? {};
    const reader = new RegistrarReader(input.db);
    const registrarId =
      typeof args.registrar_id === "string" && args.registrar_id.length > 0
        ? args.registrar_id
        : undefined;
    const status = normalizeStatus(args.status) ?? "active";
    const limit = normalizeLimit(args.limit);
    const entries = registrarId
      ? [reader.getEntry(registrarId)].filter(isRegistrarEntry)
      : reader.listEntries({ status });
    const rows = entries
      .filter((entry) => (registrarId ? entry.status === status : true))
      .slice(0, limit)
      .map((entry) => {
        const events = reader.listEvents(entry.registrar_id);
        return {
          registrar_id: entry.registrar_id,
          slug: entry.slug,
          title: entry.title,
          status: entry.status,
          phases: reader.listPhases(entry.registrar_id).map((phase) => ({
            phase_no: phase.phase_no,
            title: phase.title,
            status: phase.status,
          })),
          rollup: reader.getRollup(entry.registrar_id),
          last_event_id: events.at(-1)?.event_id ?? null,
        };
      });
    return { rows, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rows: [], warnings: [`registrar_status: ${msg}`] };
  }
}
