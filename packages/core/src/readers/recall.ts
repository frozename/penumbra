import { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import type { RecallRequest, RecallResult } from '../schemas/recall.js';
import { fuseRRF, type RankedResult } from './rrf.js';

export class RecallReader {
  private readonly db: Database;
  private readonly embedder: Embedder;

  constructor(opts: { db: Database; embedder: Embedder }) {
    this.db = opts.db;
    this.embedder = opts.embedder;
  }

  /**
   * Returns up to `req.limit` results across T0 events, T1 rollups and T2 memories.
   *
   * Each tier is queried with limit, filtered by min_score, and then fused
   * using Reciprocal Rank Fusion (RRF).
   */
  async recall(req: RecallRequest): Promise<RecallResult[]> {
    const limit = req.limit;
    const requestedSources = req.sources ?? (req.include_raw ? ['t0', 't1', 't2'] : ['t1', 't2']);

    let qvec: Float32Array | undefined;
    if (requestedSources.includes('t1') || requestedSources.includes('t2')) {
      [qvec] = await this.embedder.embed([req.query]);
    }

    let t0Results: RankedResult<RecallResult>[] = [];
    if (requestedSources.includes('t0')) {
      const raw = queryT0(this.db, {
        query: req.query,
        limit,
        project_id: req.project_id,
        session_id: req.session_id,
        event_types: req.event_types,
      });
      t0Results = raw
        .filter((r) => r.score >= req.min_score)
        .map((r) => ({
          id: r.event_id,
          score: r.score,
          payload: {
            id: r.event_id,
            tier: 't0',
            score: r.score,
            fusedScore: 0,
            sources: ['t0'],
            title: null,
            body: r.content_snippet,
            project_id: r.project_id,
            source_session_ids: r.session_id ? [r.session_id] : [],
            created_at: r.ts,
            ts: r.ts,
            payload: { event_type: r.event_type },
          },
        }));
    }

    let t1Results: RankedResult<RecallResult>[] = [];
    if (requestedSources.includes('t1') && qvec) {
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
        .query<T1Row, [Float32Array, number, string | null, string | null, string | null, string | null]>(
          `SELECT r.rollup_id, r.project_id, r.session_id, r.started_at,
                  r.first_prompt_excerpt, r.last_response_excerpt,
                  v.distance
             FROM t1_vec v
             JOIN t1_rollups r ON r.rowid = v.rowid
            WHERE v.embedding MATCH ?
              AND k = ?
              AND (? IS NULL OR r.project_id = ?)
              AND (? IS NULL OR r.session_id = ?)
            ORDER BY v.distance ASC`,
        )
        .all(qvec, limit, req.project_id, req.project_id, req.session_id ?? null, req.session_id ?? null);

      t1Results = t1Rows
        .map((r): RankedResult<RecallResult> => {
          const score = toScore(r.distance);
          return {
            id: r.rollup_id,
            score,
            payload: {
              id: r.rollup_id,
              tier: 't1' as const,
              score,
              fusedScore: 0,
              sources: ['t1'],
              title: null,
              body: [r.first_prompt_excerpt, r.last_response_excerpt].filter((s): s is string => !!s).join('\n\n'),
              project_id: r.project_id,
              source_session_ids: [r.session_id],
              created_at: r.started_at,
              ts: r.started_at,
              payload: { rollup_id: r.rollup_id },
            }
          };
        })
        .filter((r) => r.score >= req.min_score);
    }

    let t2Results: RankedResult<RecallResult>[] = [];
    if (requestedSources.includes('t2') && qvec) {
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
        .all(qvec, limit, req.project_id, req.project_id);

      t2Results = t2Rows
        .map((r): RankedResult<RecallResult> => {
          const score = toScore(r.distance);
          return {
            id: r.memory_id,
            score,
            payload: {
              id: r.memory_id,
              tier: 't2' as const,
              score,
              fusedScore: 0,
              sources: ['t2' as const],
              title: r.title,
              body: r.body,
              project_id: r.project_id,
              source_session_ids: JSON.parse(r.source_session_ids) as string[],
              created_at: r.created_at,
              ts: r.created_at,
              payload: { memory_id: r.memory_id },
            }
          };
        })
        .filter((r) => r.score >= req.min_score);
    }

    const lists = [t0Results, t1Results, t2Results];
    const sourceMap = ['t0', 't1', 't2'] as const;

    const fused = fuseRRF(lists, { k: req.rrf_k, limit });

    return fused.map((f) => ({
      ...f.payload,
      fusedScore: f.fusedScore,
      sources: f.sources.map((idx) => sourceMap[idx]!),
    }));
  }
}

export interface QueryT0Options {
  query: string;
  limit?: number; // default 50
  project_id?: string | null;
  session_id?: string;
  event_types?: string[];
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
  project_id: string | null;
  session_id: string | null;
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
    project_id: string | null;
    session_id: string | null;
  };

  const where: string[] = ['t0_fts MATCH ?'];
  const params: (string | number | null)[] = [matchQuery];

  const projectId = opts.project_id ?? null;
  if (projectId !== null) {
    where.push('e.project_id = ?');
    params.push(projectId);
  }

  if (opts.session_id !== undefined) {
    where.push('e.session_id = ?');
    params.push(opts.session_id);
  }

  if (opts.event_types && opts.event_types.length > 0) {
    const placeholders = opts.event_types.map(() => '?').join(',');
    where.push(`e.event_type IN (${placeholders})`);
    params.push(...opts.event_types);
  }

  params.push(limit);

  const rows = db
    .query<Row, (string | number | null)[]>(
      `SELECT t0_fts.event_id,
              bm25(t0_fts) AS bm25,
              t0_fts.content AS content,
              snippet(t0_fts, 0, '', '', '…', 16) AS snippet,
              e.ts,
              e.event_type,
              e.project_id,
              e.session_id
         FROM t0_fts
         JOIN t0_events e ON e.event_id = t0_fts.event_id
        WHERE ${where.join(' AND ')}
        ORDER BY bm25(t0_fts) ASC
        LIMIT ?`,
    )
    .all(...params);

  const bestBm25 = rows[0]?.bm25;

  return rows.map((r) => ({
    event_id: r.event_id,
    score: bm25ToScore(r.bm25, bestBm25),
    content_snippet: pickSnippet(r),
    ts: r.ts,
    event_type: r.event_type,
    project_id: r.project_id,
    session_id: r.session_id,
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
