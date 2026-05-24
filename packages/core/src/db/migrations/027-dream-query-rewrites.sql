-- Schema migration: add dream_query_rewrites cache
--
-- Adds a memory-id keyed LLM query rewrite cache used by the dreaming rewriter
-- pipeline. Rows are invalidated by update-epoch and expiry time during read.

CREATE TABLE IF NOT EXISTS dream_query_rewrites (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  t2_memory_id          TEXT NOT NULL,
  memory_updated_at_ms  INTEGER NOT NULL,
  verdict_kind          TEXT NOT NULL CHECK (verdict_kind IN ('query', 'skip')),
  query                 TEXT,
  skip_reason           TEXT,
  model                 TEXT NOT NULL,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (t2_memory_id, memory_updated_at_ms),
  FOREIGN KEY (t2_memory_id) REFERENCES t2_memories(memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dream_query_rewrites_t2_memory_id
  ON dream_query_rewrites(t2_memory_id);
