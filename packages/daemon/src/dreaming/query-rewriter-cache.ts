import type { Database } from 'bun:sqlite';

export type RewriteVerdict =
  | { kind: 'query'; query: string }
  | { kind: 'skip'; skip_reason: string };

export interface RewriteCacheRow {
  verdict: RewriteVerdict;
  model: string;
  created_at_ms: number;
  expires_at_ms: number;
}

export interface RewriteCacheOpts {
  db: Database;
  t2_memory_id: string;
  memory_updated_at_ms: number;
  now_ms: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function enforceVerdictInvariant(verdict: RewriteVerdict): void {
  if (verdict.kind === 'query') {
    if (!verdict.query) {
      throw new Error('query verdict requires non-empty query');
    }
    return;
  }
  if (!verdict.skip_reason) {
    throw new Error('skip verdict requires non-empty skip_reason');
  }
}

export function getRewriteForMemory(opts: RewriteCacheOpts): RewriteCacheRow | null {
  const row = opts.db
    .prepare(
      `SELECT verdict_kind, query, skip_reason, model, created_at, expires_at
         FROM dream_query_rewrites
        WHERE t2_memory_id = ?
          AND memory_updated_at_ms = ?
          AND expires_at >= ?`,
    )
    .get(opts.t2_memory_id, opts.memory_updated_at_ms, opts.now_ms) as
    | {
        verdict_kind: string;
        query: string | null;
        skip_reason: string | null;
        model: string;
        created_at: number;
        expires_at: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  if (row.verdict_kind === 'query') {
    if (!row.query) {
      return null;
    }
    return {
      verdict: { kind: 'query', query: row.query },
      model: row.model,
      created_at_ms: row.created_at,
      expires_at_ms: row.expires_at,
    };
  }

  if (row.verdict_kind === 'skip') {
    if (!row.skip_reason) {
      return null;
    }
    return {
      verdict: { kind: 'skip', skip_reason: row.skip_reason },
      model: row.model,
      created_at_ms: row.created_at,
      expires_at_ms: row.expires_at,
    };
  }

  return null;
}

export function setRewriteForMemory(opts: {
  db: Database;
  t2_memory_id: string;
  memory_updated_at_ms: number;
  verdict: RewriteVerdict;
  model: string;
  now_ms: number;
  ttl_ms?: number;
}): void {
  enforceVerdictInvariant(opts.verdict);
  const ttl = opts.ttl_ms ?? DEFAULT_TTL_MS;
  const createdAt = opts.now_ms;
  const expiresAt = opts.now_ms + ttl;

  const verdictKind = opts.verdict.kind;
  const query = opts.verdict.kind === 'query' ? opts.verdict.query : null;
  const skipReason = opts.verdict.kind === 'skip' ? opts.verdict.skip_reason : null;

  opts.db.prepare(
    `INSERT INTO dream_query_rewrites(
      t2_memory_id, memory_updated_at_ms, verdict_kind, query, skip_reason, model, expires_at, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(t2_memory_id, memory_updated_at_ms) DO UPDATE SET
      verdict_kind=excluded.verdict_kind,
      query=excluded.query,
      skip_reason=excluded.skip_reason,
      model=excluded.model,
      expires_at=excluded.expires_at,
      created_at=excluded.created_at`,
  ).run(
    opts.t2_memory_id,
    opts.memory_updated_at_ms,
    verdictKind,
    query,
    skipReason,
    opts.model,
    expiresAt,
    createdAt,
  );
}
