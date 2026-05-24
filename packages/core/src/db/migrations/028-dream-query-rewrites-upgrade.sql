-- Upgrade dream_query_rewrites to model-scoped cache key, reason naming, and invariants.

PRAGMA foreign_keys = OFF;
BEGIN;

ALTER TABLE dream_query_rewrites RENAME TO dream_query_rewrites_v27;

CREATE TABLE dream_query_rewrites (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  t2_memory_id          TEXT NOT NULL,
  memory_updated_at_ms  INTEGER NOT NULL,
  verdict_kind          TEXT NOT NULL CHECK (verdict_kind IN ('query', 'skip')),
  query                 TEXT,
  reason                TEXT,
  model                 TEXT NOT NULL,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  CHECK (verdict_kind != 'query' OR query IS NOT NULL),
  CHECK (verdict_kind != 'skip' OR reason IS NOT NULL),
  UNIQUE (t2_memory_id, memory_updated_at_ms, model),
  FOREIGN KEY (t2_memory_id) REFERENCES t2_memories(memory_id) ON DELETE CASCADE
);

INSERT INTO dream_query_rewrites(
  t2_memory_id, memory_updated_at_ms, verdict_kind, query, reason, model, expires_at, created_at
)
SELECT
  t2_memory_id,
  memory_updated_at_ms,
  verdict_kind,
  query,
  COALESCE(reason, skip_reason),
  model,
  expires_at,
  created_at
FROM dream_query_rewrites_v27
WHERE
  (verdict_kind != 'query' OR query IS NOT NULL)
  AND (verdict_kind != 'skip' OR COALESCE(reason, skip_reason) IS NOT NULL);

DROP TABLE dream_query_rewrites_v27;
DROP INDEX IF EXISTS idx_dream_query_rewrites_t2_memory_id;
CREATE INDEX IF NOT EXISTS idx_dream_query_rewrites_t2_memory_id
  ON dream_query_rewrites(t2_memory_id);

PRAGMA foreign_keys = ON;
COMMIT;
