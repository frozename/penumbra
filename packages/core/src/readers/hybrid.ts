import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Embedder } from "../embedder/interface.js";
import {
  combineFilters,
  conceptFilter,
  dateFilter,
  fileFilter,
  projectFilter,
  typeFilter,
} from "./filters/index.js";
import { toScore } from "./vec-score.js";

export interface HybridRequest {
  query: string;
  limit: number;
  project_id?: string | null;
  obs_type?: string;
  concept?: string;
  file_path?: string;
  dateStart?: string;
  dateEnd?: string;
  candidate_pool?: number; // how many SQL candidates feed the rerank; default 4×limit
}

export interface HybridHit {
  id: string;
  ts: string;
  obs_type: string | null;
  title: string;
  body: string;
  score: number;
  project_id: string | null;
  source_session_ids: string[];
  why?: string | null;
  source_quote?: string | null;
  learned_at?: string | null;
  last_verified_at?: string | null;
}

export async function hybridSearch(
  db: Database,
  embedder: Embedder,
  req: HybridRequest,
): Promise<HybridHit[]> {
  const pool = req.candidate_pool ?? Math.max(50, req.limit * 4);
  const filters = [
    projectFilter(req.project_id, "m.project_id"),
    typeFilter(req.obs_type, "m.obs_type"),
    conceptFilter(req.concept, "m.concepts"),
    fileFilter(req.file_path, "m.file_paths"),
    dateFilter(req.dateStart, req.dateEnd, "m.created_at"),
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const { whereSql, params } = combineFilters(filters);

  // Stage 1: SQL pre-filter on metadata.
  const candidates = db
    .query<
      {
        memory_id: string;
        rowid: number;
        created_at: string;
        obs_type: string | null;
        title: string;
        body: string;
        project_id: string | null;
        source_session_ids: string;
        why: string | null;
        source_quote: string | null;
        learned_at: string | null;
        last_verified_at: string | null;
      },
      SQLQueryBindings[]
    >(
      `SELECT m.memory_id, m.rowid, m.created_at, m.obs_type, m.title, m.body, m.project_id,
              m.source_session_ids, m.why, m.source_quote, m.learned_at, m.last_verified_at
         FROM t2_memories m
        WHERE ${whereSql}
          AND m.retired_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(...params, pool);
  if (candidates.length === 0) return [];

  // Stage 2: vector rerank against just those rowids.
  const [qvec] = await embedder.embed([req.query]);
  const qBlob = new Float32Array(qvec!);
  const placeholders = candidates.map(() => "?").join(",");
  const ranked = db
    .query<{ rowid: number; distance: number }, SQLQueryBindings[]>(
      `SELECT v.rowid, v.distance
         FROM t2_vec v
        WHERE v.rowid IN (${placeholders})
          AND embedding MATCH ?
          AND k = ?
        ORDER BY distance ASC`,
    )
    .all(...([...candidates.map((c) => c.rowid), qBlob, req.limit] as SQLQueryBindings[]));

  const byRowid = new Map(candidates.map((c) => [c.rowid, c] as const));
  return ranked
    .map((r) => {
      const c = byRowid.get(r.rowid);
      if (!c) return null;
      return {
        id: c.memory_id,
        ts: c.created_at,
        obs_type: c.obs_type,
        title: c.title,
        body: c.body,
        score: toScore(r.distance),
        project_id: c.project_id,
        source_session_ids: parseSourceSessionIds(c.source_session_ids),
        why: c.why,
        source_quote: c.source_quote,
        learned_at: c.learned_at,
        last_verified_at: c.last_verified_at,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

function parseSourceSessionIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}
