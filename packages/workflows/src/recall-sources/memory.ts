import type { Database } from 'bun:sqlite';

export type MemorySearchInput = {
  db: Database;
  embedder: { embed(texts: string[]): Promise<Float32Array[]> };
  args: { query?: string; project?: string; limit?: number; obs_type?: string; dateStart?: string; dateEnd?: string; exclude_user_ids?: string[] };
};

export type MemoryHit = {
  id: string;
  title: string;
  snippet: string;
  ts: string;
  score: number;
};

export type MemorySearchOutput = { hits: MemoryHit[]; warnings: string[] };

function buildTitleSnippet(title: string, body: string): { title: string; snippet: string } {
  const firstLine = (title && title.length > 0) ? title : (body.split('\n', 1)[0] ?? body);
  return { title: firstLine.slice(0, 120), snippet: body.slice(0, 240) };
}

// FTS5's default tokenizer rejects non-alphanumeric characters in query expressions
// (e.g. "src/foo.ts" raises "syntax error near /"). Callers commonly pass file paths
// or commit subjects, so normalize punctuation to whitespace and collapse runs to
// keep the meaningful tokens.
function sanitizeFtsQuery(q: string): string {
  return q.replace(/[^A-Za-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function runMemorySearchSource(input: MemorySearchInput): Promise<MemorySearchOutput> {
  const { db, args } = input;
  const limit = args.limit ?? 20;
  const warnings: string[] = [];

  if (!args.query && !args.dateStart && !args.dateEnd && !args.obs_type) {
    return { hits: [], warnings: ['memory.search: no query/date/obs_type provided'] };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.project) {
    conditions.push("(t.project_id = ? OR t.project_id IS NULL OR t.project_id = '')");
    params.push(args.project);
  }
  if (args.dateStart) {
    conditions.push('t.created_at >= ?');
    params.push(args.dateStart);
  }
  if (args.dateEnd) {
    conditions.push('t.created_at <= ?');
    params.push(args.dateEnd);
  }
  if (args.obs_type) {
    conditions.push('t.obs_type = ?');
    params.push(args.obs_type);
  }
  if (Array.isArray(args.exclude_user_ids) && args.exclude_user_ids.length > 0) {
    const placeholders = args.exclude_user_ids.map(() => '?').join(', ');
    conditions.push(`t.user_id NOT IN (${placeholders})`);
    for (const uid of args.exclude_user_ids) params.push(uid);
  }

  let sql: string;
  const sanitizedQuery = args.query ? sanitizeFtsQuery(args.query) : '';
  if (args.query && sanitizedQuery.length > 0) {
    sql = `
      SELECT t.memory_id AS memory_id, t.title AS title, t.body AS body, t.created_at AS created_at, bm25(t2_fts) AS score
      FROM t2_fts f
      JOIN t2_memories t ON t.rowid = f.rowid
      WHERE t2_fts MATCH ?
      ${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
      ORDER BY score
      LIMIT ?
    `;
    params.unshift(sanitizedQuery);
    params.push(limit);
  } else if (args.query) {
    return { hits: [], warnings: ['memory.search: query reduced to empty after sanitization'] };
  } else {
    const whereConditions = conditions.map((c) => c.replace(/\bt\./g, ''));
    sql = `
      SELECT memory_id, title, body, created_at, 0 AS score
      FROM t2_memories
      ${whereConditions.length ? 'WHERE ' + whereConditions.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(limit);
  }

  try {
    const rows = db.query(sql).all(...(params as never[])) as Array<{
      memory_id: string;
      title: string;
      body: string;
      created_at: string;
      score: number;
    }>;
    const hits: MemoryHit[] = rows.map((r) => {
      const { title, snippet } = buildTitleSnippet(r.title, r.body);
      return { id: `t2:${r.memory_id}`, title, snippet, ts: r.created_at, score: r.score };
    });
    return { hits, warnings };
  } catch (err: any) {
    return { hits: [], warnings: [`memory.search: ${err?.message ?? String(err)}`] };
  }
}
