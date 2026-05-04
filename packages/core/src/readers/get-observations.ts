import type { Database } from 'bun:sqlite';
import type { GetObservationsRequest, ObservationDetail } from '../schemas/recall.js';

/**
 * Batch hydrate t2 memories by ID, preserving the requested order. Step 3 of
 * the search → timeline → get_observations workflow; agents call this only for
 * the IDs they actually want full bodies for.
 */
export function getObservations(db: Database, req: GetObservationsRequest): ObservationDetail[] {
  if (req.ids.length === 0) return [];
  const placeholders = req.ids.map(() => '?').join(',');
  type Row = {
    memory_id: string;
    created_at: string;
    project_id: string | null;
    obs_type: string | null;
    severity: string | null;
    concepts: string | null;
    file_paths: string | null;
    title: string;
    body: string;
  };
  const rows = db
    .query<Row, string[]>(
      `SELECT memory_id, created_at, project_id, obs_type, severity, concepts, file_paths, title, body
         FROM t2_memories WHERE memory_id IN (${placeholders})`,
    )
    .all(...req.ids);
  const byId = new Map(rows.map((r) => [r.memory_id, r] as const));
  const out: ObservationDetail[] = [];
  for (const id of req.ids) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      id: r.memory_id,
      tier: 't2',
      ts: r.created_at,
      project_id: r.project_id,
      obs_type: r.obs_type,
      severity: r.severity,
      concepts: JSON.parse(r.concepts ?? '[]'),
      file_paths: JSON.parse(r.file_paths ?? '[]'),
      title: r.title,
      body: r.body,
    });
  }
  return out;
}
