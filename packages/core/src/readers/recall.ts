import { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import type { RecallRequest, RecallResult } from '../schemas/recall.js';

export class RecallReader {
  private readonly db: Database;
  private readonly embedder: Embedder;

  constructor(opts: { db: Database; embedder: Embedder }) {
    this.db = opts.db;
    this.embedder = opts.embedder;
  }

  /**
   * Returns up to `req.limit` results across T1 rollups and T2 memories combined.
   *
   * Each tier is queried with k = req.limit, filtered by min_score, then the
   * two lists are merged, re-sorted by score desc, and sliced back to req.limit.
   * This means a single tier can saturate the result set.
   */
  async recall(req: RecallRequest): Promise<RecallResult[]> {
    const [qvec] = await this.embedder.embed([req.query]);

    type T1Row = {
      rollup_id: string;
      project_id: string | null;
      session_id: string;
      started_at: string;
      first_prompt_excerpt: string | null;
      last_response_excerpt: string | null;
      distance: number;
    };
    const t1Rows = this.db
      .query<T1Row, [Float32Array, number, string | null, string | null]>(
        `SELECT r.rollup_id, r.project_id, r.session_id, r.started_at,
                r.first_prompt_excerpt, r.last_response_excerpt,
                v.distance
           FROM t1_vec v
           JOIN t1_rollups r ON r.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND k = ?
            AND (? IS NULL OR r.project_id = ?)
          ORDER BY v.distance ASC`,
      )
      .all(qvec!, req.limit, req.project_id, req.project_id);

    const t1 = t1Rows
      .map((r): RecallResult => ({
        id: r.rollup_id,
        tier: 't1',
        score: toScore(r.distance),
        title: null,
        body: [r.first_prompt_excerpt, r.last_response_excerpt].filter((s): s is string => !!s).join('\n\n'),
        project_id: r.project_id,
        source_session_ids: [r.session_id],
        created_at: r.started_at,
      }))
      .filter((r) => r.score >= req.min_score);

    type T2Row = {
      memory_id: string;
      project_id: string | null;
      title: string;
      body: string;
      created_at: string;
      source_session_ids: string;
      distance: number;
    };
    const t2Rows = this.db
      .query<T2Row, [Float32Array, number, string | null, string | null]>(
        `SELECT m.memory_id, m.project_id, m.title, m.body, m.created_at, m.source_session_ids,
                v.distance
           FROM t2_vec v
           JOIN t2_memories m ON m.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND k = ?
            AND (? IS NULL OR m.project_id = ?)
          ORDER BY v.distance ASC`,
      )
      .all(qvec!, req.limit, req.project_id, req.project_id);

    const t2 = t2Rows
      .map((r): RecallResult => ({
        id: r.memory_id,
        tier: 't2',
        score: toScore(r.distance),
        title: r.title,
        body: r.body,
        project_id: r.project_id,
        source_session_ids: JSON.parse(r.source_session_ids) as string[],
        created_at: r.created_at,
      }))
      .filter((r) => r.score >= req.min_score);

    return [...t1, ...t2]
      .sort((a, b) => b.score - a.score)
      .slice(0, req.limit);
  }
}

export interface QueryT0Options {
  query: string;
  limit?: number; // default 50
  project_id?: string | null;
}

export interface T0RecallResult {
  event_id: string;
  /**
   * Normalized lexical relevance score in [0, 1].
   *
   * SQLite FTS5 `bm25()` returns lower-is-better scores (often negative). This
   * maps results into a similarity-like score where higher is better by
   * normalizing each row relative to the best match in the result set:
   * `score = 1 / (1 + max(0, bm25 - bestBm25))`.
   */
  score: number;
  content_snippet: string;
  ts: string;
  event_type: string;
}

export function queryT0(db: Database, opts: QueryT0Options): T0RecallResult[] {
  const limit = opts.limit ?? 50;
  const q = opts.query.trim();
  if (!q) return [];

  const matchQuery = sanitizeFts5Query(q);
  if (!matchQuery) return [];

  type Row = {
    event_id: string;
    bm25: number;
    content: string;
    snippet: string | null;
    ts: string;
    event_type: string;
  };

  const projectId = opts.project_id ?? null;
  const rows = db
    .query<Row, [string, string | null, string | null, number]>(
      `SELECT t0_fts.event_id,
              bm25(t0_fts) AS bm25,
              t0_fts.content AS content,
              snippet(t0_fts, 0, '', '', '…', 16) AS snippet,
              e.ts,
              e.event_type
         FROM t0_fts
         JOIN t0_events e ON e.event_id = t0_fts.event_id
        WHERE t0_fts MATCH ?
          AND (? IS NULL OR e.project_id = ?)
        ORDER BY bm25(t0_fts) ASC
        LIMIT ?`,
    )
    .all(matchQuery, projectId, projectId, limit);

  const bestBm25 = rows[0]?.bm25;

  return rows.map((r) => ({
    event_id: r.event_id,
    score: bm25ToScore(r.bm25, bestBm25),
    content_snippet: pickSnippet(r),
    ts: r.ts,
    event_type: r.event_type,
  }));
}

function toScore(distance: number): number {
  // sqlite-vec returns L2 distance on normalized vectors in [0, 2].
  // Convert to a [0, 1]-ish similarity: 1 - distance/2.
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

function bm25ToScore(bm25: number, bestBm25: number | undefined): number {
  if (!Number.isFinite(bm25) || bestBm25 === undefined || !Number.isFinite(bestBm25)) return 0;
  const delta = bm25 - bestBm25;
  return 1 / (1 + Math.max(0, delta));
}

function pickSnippet(row: { snippet: string | null; content: string }): string {
  const snippet = row.snippet?.trim();
  if (snippet) return snippet;
  return row.content.slice(0, 200);
}

function sanitizeFts5Query(raw: string): string {
  const tokens = raw
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => /[0-9A-Za-z]/.test(t))
    .slice(0, 20);

  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${escapeFts5PhraseToken(t)}"`).join(' OR ');
}

function escapeFts5PhraseToken(token: string): string {
  // FTS5 phrase quoting escapes `"` by doubling: foo"bar -> "foo""bar"
  return token.replaceAll('"', '""');
}
