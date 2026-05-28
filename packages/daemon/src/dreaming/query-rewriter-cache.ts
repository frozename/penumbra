import type { Database } from "bun:sqlite";

export type RewriteVerdict = { kind: "query"; query: string } | { kind: "skip"; reason: string };

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
  model: string;
  now_ms: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function enforceVerdictInvariant(verdict: RewriteVerdict): void {
  if (verdict.kind === "query") {
    if (!verdict.query) {
      throw new Error("query verdict requires non-empty query");
    }
    return;
  }
  if (!verdict.reason) {
    throw new Error("skip verdict requires non-empty reason");
  }
}

interface RewriteCacheStatements {
  get: ReturnType<Database["prepare"]>;
  set: ReturnType<Database["prepare"]>;
  prune: ReturnType<Database["prepare"]>;
}

const rewriteCacheStatements = new WeakMap<Database, RewriteCacheStatements>();
const rewriteCacheTablePresence = new WeakMap<Database, boolean>();

function hasRewriteCacheTable(db: Database): boolean {
  const cached = rewriteCacheTablePresence.get(db);
  if (cached !== undefined) return cached;

  const exists =
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='dream_query_rewrites'`)
      .get() !== null;
  rewriteCacheTablePresence.set(db, exists);
  return exists;
}

function getRewriteCacheStatements(db: Database): RewriteCacheStatements | null {
  if (!hasRewriteCacheTable(db)) return null;

  const existing = rewriteCacheStatements.get(db);
  if (existing) {
    return existing;
  }

  const statements: RewriteCacheStatements = {
    get: db.prepare(
      `SELECT verdict_kind, query, reason, model, created_at, expires_at
        FROM dream_query_rewrites
        WHERE t2_memory_id = ?
          AND memory_updated_at_ms = ?
          AND model = ?
          AND expires_at > ?`,
    ),
    set: db.prepare(
      `INSERT INTO dream_query_rewrites(
       t2_memory_id, memory_updated_at_ms, verdict_kind, query, reason, model, expires_at, created_at
      ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(t2_memory_id, memory_updated_at_ms, model) DO UPDATE SET
        verdict_kind=excluded.verdict_kind,
        query=excluded.query,
        reason=excluded.reason,
        model=excluded.model,
        expires_at=excluded.expires_at,
        created_at=excluded.created_at`,
    ),
    prune: db.prepare(`DELETE FROM dream_query_rewrites WHERE expires_at < ?`),
  };
  rewriteCacheStatements.set(db, statements);
  return statements;
}

export function pruneExpiredRewriteCache(db: Database, now_ms: number): void {
  const statements = getRewriteCacheStatements(db);
  if (!statements) return;
  const { prune } = statements;
  prune.run(now_ms);
}

export function getRewriteForMemory(opts: RewriteCacheOpts): RewriteCacheRow | null {
  const statements = getRewriteCacheStatements(opts.db);
  if (!statements) return null;
  const { get } = statements;
  const row = get.get(opts.t2_memory_id, opts.memory_updated_at_ms, opts.model, opts.now_ms) as
    | {
        verdict_kind: string;
        query: string | null;
        reason: string | null;
        model: string;
        created_at: number;
        expires_at: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  if (row.verdict_kind === "query") {
    if (!row.query) {
      return null;
    }
    return {
      verdict: { kind: "query", query: row.query },
      model: row.model,
      created_at_ms: row.created_at,
      expires_at_ms: row.expires_at,
    };
  }

  if (row.verdict_kind === "skip") {
    if (!row.reason) {
      return null;
    }
    return {
      verdict: { kind: "skip", reason: row.reason },
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
  const query = opts.verdict.kind === "query" ? opts.verdict.query : null;
  const reason = opts.verdict.kind === "skip" ? opts.verdict.reason : null;
  const statements = getRewriteCacheStatements(opts.db);
  if (!statements) return;
  const { set } = statements;

  set.run(
    opts.t2_memory_id,
    opts.memory_updated_at_ms,
    verdictKind,
    query,
    reason,
    opts.model,
    expiresAt,
    createdAt,
  );
}
