import type { Database } from 'bun:sqlite';
import { computeAgeDays, staleThresholdDays, type SearchRequest, type SearchHit } from '../schemas/recall.js';

const SNIPPET_LEN = 120;
function snippetFromBody(body: string): string {
  if (body.length <= SNIPPET_LEN) return body;
  return `${body.slice(0, SNIPPET_LEN - 1).trim()}…`;
}

function sanitizeFtsQuery(input: string): string {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens
    .map((tok) => {
      if (/^[A-Za-z0-9_]+$/.test(tok)) return tok;
      return `"${tok.replace(/"/g, '""')}"`;
    })
    .join(' ');
}

/**
 * Compact-index search across t1_fts/t2_fts. Returns short rows (id + title +
 * snippet + score) so agents can scan many hits cheaply, then hand IDs to
 * `timeline` or `get_observations` for the few they actually want.
 */
export function search(db: Database, req: SearchRequest): SearchHit[] {
  const tiers = req.tiers ?? ['t1', 't2'];
  const limit = req.limit;
  const offset = req.offset ?? 0;
  const hits: SearchHit[] = [];
  const now = Date.now();

  if (tiers.includes('t2')) {
    const where: string[] = ['t2_fts MATCH ?'];
    const params: (string | number | null)[] = [sanitizeFtsQuery(req.query)];

    // null = no filter (matches existing recall convention); non-null = exact match.
    if (req.project_id != null) {
      where.push('m.project_id = ?');
      params.push(req.project_id);
    }
    if (req.obs_type) {
      where.push('m.obs_type = ?');
      params.push(req.obs_type);
    }
    if (req.concept) {
      where.push("m.concepts LIKE '%' || ? || '%'");
      params.push(req.concept);
    }
    if (req.file_path) {
      where.push("m.file_paths LIKE '%' || ? || '%'");
      params.push(req.file_path);
    }
    if (req.dateStart) {
      where.push('m.created_at >= ?');
      params.push(req.dateStart);
    }
    if (req.dateEnd) {
      where.push('m.created_at <= ?');
      params.push(req.dateEnd);
    }

    const sql = `
      SELECT m.memory_id AS id, m.created_at AS ts, m.obs_type AS obs_type, m.title AS title,
             m.body AS body, m.project_id AS project_id, m.last_verified_at AS last_verified_at,
             m.last_verified_by AS last_verified_by, m.last_verified_reason AS last_verified_reason,
             m.last_verified_session_id AS last_verified_session_id,
             m.created_at, bm25(t2_fts) AS score
        FROM t2_fts JOIN t2_memories m ON m.rowid = t2_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY score
       LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = db
      .query<
        {
          id: string;
          ts: string;
          obs_type: string | null;
          title: string;
          body: string;
          project_id: string | null;
          last_verified_at: string | null;
          last_verified_by: string | null;
          last_verified_reason: string | null;
          last_verified_session_id: string | null;
          created_at: string;
          score: number;
        },
        (string | number | null)[]
      >(sql)
      .all(...params);

    for (const row of rows) {
      const ageDays = computeAgeDays(now, row.created_at, row.last_verified_at);
      hits.push({
        id: row.id,
        tier: 't2',
        ts: row.ts,
        obs_type: row.obs_type,
        title: row.title,
        snippet: snippetFromBody(row.body),
        project_id: row.project_id,
        score: row.score,
        last_verified_at: row.last_verified_at,
        last_verified_by: row.last_verified_by,
        last_verified_reason: row.last_verified_reason,
        last_verified_session_id: row.last_verified_session_id,
        age_days: ageDays ?? undefined,
        stale: ageDays === null ? true : ageDays >= staleThresholdDays(row.obs_type),
      });
    }
  }

  if (tiers.includes('t1')) {
    const where: string[] = ['t1_fts MATCH ?'];
    const params: (string | number | null)[] = [sanitizeFtsQuery(req.query)];
    if (req.project_id != null) {
      where.push('r.project_id = ?');
      params.push(req.project_id);
    }
    if (req.dateStart) {
      where.push('r.ended_at >= ?');
      params.push(req.dateStart);
    }
    if (req.dateEnd) {
      where.push('r.ended_at <= ?');
      params.push(req.dateEnd);
    }
    const sql = `
      SELECT r.rollup_id AS id, COALESCE(r.ended_at, r.started_at) AS ts,
             r.first_prompt_excerpt AS prompt, r.last_response_excerpt AS resp,
             r.project_id AS project_id, bm25(t1_fts) AS score
        FROM t1_fts JOIN t1_rollups r ON r.rowid = t1_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY score
       LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = db
      .query<
        {
          id: string;
          ts: string;
          prompt: string | null;
          resp: string | null;
          project_id: string | null;
          score: number;
        },
        (string | number | null)[]
      >(sql)
      .all(...params);

    for (const row of rows) {
      hits.push({
        id: row.id,
        tier: 't1',
        ts: row.ts,
        title: row.prompt ?? '(no prompt)',
        snippet: snippetFromBody(row.resp ?? ''),
        project_id: row.project_id,
        score: row.score,
      });
    }
  }

  // Lower bm25 = better. Stable sort by score, then ts desc as tiebreak.
  hits.sort((a, b) => a.score - b.score || b.ts.localeCompare(a.ts));
  return hits.slice(0, limit);
}
