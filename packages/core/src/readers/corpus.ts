import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Embedder } from "../embedder/interface.js";
import type { HybridHit } from "./hybrid.js";
import {
  combineFilters,
  conceptFilter,
  dateFilter,
  fileFilter,
  projectFilter,
  typeFilter,
} from "./filters/index.js";
import { toScore } from "./vec-score.js";

export interface CorpusFilter {
  project_id?: string | null;
  obs_type?: string;
  concept?: string;
  file_path?: string;
  dateStart?: string;
  dateEnd?: string;
  limit?: number;
}

export interface BuildCorpusInput {
  name: string;
  description?: string;
  filter: CorpusFilter;
}

export interface CorpusSummary {
  corpus_id: string;
  name: string;
  description: string | null;
  member_count: number;
  created_at: string;
}

export async function buildCorpus(
  db: Database,
  _embedder: Embedder,
  input: BuildCorpusInput,
): Promise<CorpusSummary> {
  const filterContribs = [
    projectFilter(input.filter.project_id, "m.project_id"),
    typeFilter(input.filter.obs_type, "m.obs_type"),
    conceptFilter(input.filter.concept, "m.concepts"),
    fileFilter(input.filter.file_path, "m.file_paths"),
    dateFilter(input.filter.dateStart, input.filter.dateEnd, "m.created_at"),
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const { whereSql, params } = combineFilters(filterContribs);
  const cap = input.filter.limit ?? 500;

  const rows = db
    .query<
      { memory_id: string },
      SQLQueryBindings[]
    >(`SELECT m.memory_id FROM t2_memories m WHERE ${whereSql} ORDER BY m.created_at DESC LIMIT ?`)
    .all(...params, cap);

  const now = new Date().toISOString();
  const newId = randomUUID();
  db.run(
    `INSERT INTO corpora(corpus_id, name, description, filter_json, created_at, updated_at, member_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET filter_json=excluded.filter_json, updated_at=excluded.updated_at, member_count=excluded.member_count`,
    [
      newId,
      input.name,
      input.description ?? null,
      JSON.stringify(input.filter),
      now,
      now,
      rows.length,
    ],
  );

  const existing = db
    .query<
      { corpus_id: string; created_at: string },
      [string]
    >(`SELECT corpus_id, created_at FROM corpora WHERE name=?`)
    .get(input.name)!;

  db.run(`DELETE FROM corpus_members WHERE corpus_id=?`, [existing.corpus_id]);
  if (rows.length > 0) {
    const insertMember = db.prepare(
      `INSERT INTO corpus_members(corpus_id, memory_id, added_at) VALUES (?, ?, ?)`,
    );
    for (const r of rows) insertMember.run(existing.corpus_id, r.memory_id, now);
  }

  return {
    corpus_id: existing.corpus_id,
    name: input.name,
    description: input.description ?? null,
    member_count: rows.length,
    created_at: existing.created_at,
  };
}

export function listCorpora(db: Database): CorpusSummary[] {
  return db
    .query<
      {
        corpus_id: string;
        name: string;
        description: string | null;
        member_count: number;
        created_at: string;
      },
      []
    >(
      `SELECT corpus_id, name, description, member_count, created_at
         FROM corpora ORDER BY created_at DESC`,
    )
    .all();
}

export function removeCorpus(db: Database, name: string): boolean {
  const target = db
    .query<{ corpus_id: string }, [string]>(`SELECT corpus_id FROM corpora WHERE name=?`)
    .get(name);
  if (!target) return false;
  db.run(`DELETE FROM corpus_members WHERE corpus_id=?`, [target.corpus_id]);
  db.run(`DELETE FROM corpora WHERE corpus_id=?`, [target.corpus_id]);
  return true;
}

export async function queryCorpus(
  db: Database,
  embedder: Embedder,
  req: { name: string; query: string; limit?: number },
): Promise<HybridHit[]> {
  const limit = req.limit ?? 10;
  const corpus = db
    .query<{ corpus_id: string }, [string]>(`SELECT corpus_id FROM corpora WHERE name=?`)
    .get(req.name);
  if (!corpus) return [];

  const memberRows = db
    .query<
      { memory_id: string },
      [string]
    >(`SELECT memory_id FROM corpus_members WHERE corpus_id=?`)
    .all(corpus.corpus_id);
  if (memberRows.length === 0) return [];

  const memberPlaceholders = memberRows.map(() => "?").join(",");
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
      },
      string[]
    >(
      `SELECT memory_id, rowid, created_at, obs_type, title, body, project_id, source_session_ids
         FROM t2_memories WHERE memory_id IN (${memberPlaceholders})`,
    )
    .all(...memberRows.map((m) => m.memory_id));
  if (candidates.length === 0) return [];

  const [qvec] = await embedder.embed([req.query]);
  const qBlob = new Float32Array(qvec!);
  const candPlaceholders = candidates.map(() => "?").join(",");
  const ranked = db
    .query<{ rowid: number; distance: number }, SQLQueryBindings[]>(
      `SELECT v.rowid, v.distance FROM t2_vec v
        WHERE v.rowid IN (${candPlaceholders})
          AND embedding MATCH ?
        ORDER BY distance ASC LIMIT ?`,
    )
    .all(...([...candidates.map((c) => c.rowid), qBlob, limit] as SQLQueryBindings[]));

  const byRowid = new Map(candidates.map((c) => [c.rowid, c] as const));
  return ranked
    .map((r): HybridHit | null => {
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
      };
    })
    .filter((x): x is HybridHit => x !== null);
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
