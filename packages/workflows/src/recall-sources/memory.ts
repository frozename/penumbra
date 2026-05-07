import type { Database } from 'bun:sqlite';

export type MemorySearchInput = {
  db: Database;
  embedder: { embed(texts: string[]): Promise<Float32Array[]> };
  args: {
    query?: string;
    project?: string;
    limit?: number;
    obs_type?: string;
    dateStart?: string;
    dateEnd?: string;
    exclude_user_ids?: string[];
    exclude_session_prefix?: string[];
    origin?: ('maestro' | 'dispatch' | 'unknown')[];
    tiers?: ('t1' | 't2')[];
  };
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
  const tiers = args.tiers ?? ['t2'];

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
  if (Array.isArray(args.exclude_session_prefix) && args.exclude_session_prefix.length > 0) {
    const likeClauses = args.exclude_session_prefix.map(() => 'sid.value LIKE ?').join(' OR ');
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM json_each(t.source_session_ids) AS sid WHERE ${likeClauses})`,
    );
    for (const prefix of args.exclude_session_prefix) params.push(`${prefix}%`);
  }
  if (Array.isArray(args.origin) && args.origin.length > 0) {
    // Legacy rows have NULL origin and are treated as 'unknown'-equivalent —
    // give them a free pass so the filter doesn't exclude pre-tagging history.
    const placeholders = args.origin.map(() => '?').join(', ');
    conditions.push(`(t.origin IN (${placeholders}) OR t.origin IS NULL)`);
    for (const o of args.origin) params.push(o);
  }

  const sanitizedQuery = args.query ? sanitizeFtsQuery(args.query) : '';
  if (args.query && sanitizedQuery.length === 0) {
    return { hits: [], warnings: ['memory.search: query reduced to empty after sanitization'] };
  }

  try {
    const hits: MemoryHit[] = [];
    for (const tier of tiers) {
      const tierTable = tier === 't1' ? 't1_memories' : 't2_memories';
      const tierFts = tier === 't1' ? 't1_fts' : 't2_fts';
      const tierConditions = [...conditions];
      const tierParams: unknown[] = [...params];

      if (args.query && sanitizedQuery.length > 0) {
        const sql = `
          SELECT t.memory_id AS memory_id, t.title AS title, t.body AS body, t.created_at AS created_at, bm25(${tierFts}) AS score
          FROM ${tierFts} f
          JOIN ${tierTable} t ON t.rowid = f.rowid
          WHERE ${tierFts} MATCH ?
          ${tierConditions.length ? 'AND ' + tierConditions.join(' AND ') : ''}
          ORDER BY score
          LIMIT ?
        `;
        tierParams.unshift(sanitizedQuery);
        tierParams.push(limit);
        const rows = db.query(sql).all(...(tierParams as never[])) as Array<{
          memory_id: string;
          title: string;
          body: string;
          created_at: string;
          score: number;
        }>;
        for (const r of rows) {
          const { title, snippet } = buildTitleSnippet(r.title, r.body);
          hits.push({ id: `${tier}:${r.memory_id}`, title, snippet, ts: r.created_at, score: r.score });
        }
      } else {
        const whereConditions = tierConditions.map((c) => c.replace(/\bt\./g, ''));
        const sql = `
          SELECT memory_id, title, body, created_at, 0 AS score
          FROM ${tierTable}
          ${whereConditions.length ? 'WHERE ' + whereConditions.join(' AND ') : ''}
          ORDER BY created_at DESC
          LIMIT ?
        `;
        tierParams.push(limit);
        const rows = db.query(sql).all(...(tierParams as never[])) as Array<{
          memory_id: string;
          title: string;
          body: string;
          created_at: string;
          score: number;
        }>;
        for (const r of rows) {
          const { title, snippet } = buildTitleSnippet(r.title, r.body);
          hits.push({ id: `${tier}:${r.memory_id}`, title, snippet, ts: r.created_at, score: r.score });
        }
      }
    }
    hits.sort((a, b) => a.score - b.score || b.ts.localeCompare(a.ts));
    const finalHits = hits.slice(0, limit);
    return { hits: finalHits, warnings };
  } catch (err: any) {
    return { hits: [], warnings: [`memory.search: ${err?.message ?? String(err)}`] };
  }
}
