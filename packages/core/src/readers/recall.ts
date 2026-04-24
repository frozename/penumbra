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

function toScore(distance: number): number {
  // sqlite-vec returns L2 distance on normalized vectors in [0, 2].
  // Convert to a [0, 1]-ish similarity: 1 - distance/2.
  return Math.max(0, Math.min(1, 1 - distance / 2));
}
