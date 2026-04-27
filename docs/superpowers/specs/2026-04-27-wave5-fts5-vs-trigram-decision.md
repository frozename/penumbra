# Wave 5 — FTS5 vs Trigram for t0 Lexical Recall

## TL;DR
- **Recommendation**: **FTS5** (Native FTS5 virtual table with an extraction trigger).
- **Rationale**:
  - `bun:sqlite` natively ships with FTS5. It is zero-dependency and zero-maintenance.
  - At our current t0 scale (~13,500 rows in the live database), the write overhead of an FTS5 trigger is virtually zero.
  - It natively provides BM25 scoring, ranking, and prefix matching out of the box, cleanly slotting into the upcoming RRF fusion logic.
- **Migration cost**: Low. Requires a single `CREATE VIRTUAL TABLE`, two DB triggers, and a fast atomic backfill of ~13.5k rows.

## Codebase Grounding
- **Current t0 schema and write path**: The `t0_events` table stores `payload_json` as raw text. Writes happen directly via `db.prepare('INSERT INTO t0_events ...')` in `packages/core/src/writers/t0.ts` (line 9).
- **Current recall code (t1/t2)**: Implemented in `packages/core/src/readers/recall.ts`. It queries the `t1_vec` and `t2_vec` virtual tables using the `vec0` extension, mapping `v.distance` to a [0, 1] score.
- **bun:sqlite FTS5 availability**: **Yes**, verified dynamically in our Bun runtime (`CREATE VIRTUAL TABLE fts_test USING fts5(content)` works out of the box).

## Option A — FTS5 (Recommended)
- **Pros**: Built-in feature. Extremely fast. BM25 scoring maps cleanly to semantic ranking concepts. Supports `prefix='2 3'` for partial word matches. Can even use `tokenize='trigram'` natively within FTS5 if strict infix matching for code symbols is desired.
- **Cons**: Cannot be applied directly to `payload_json` because structural JSON characters (braces, quotes) pollute the tokenizer vocabulary. Requires a trigger to extract the raw text content (e.g., `json_extract(payload_json, '$.message')`) into the FTS5 index.
- **Code-cost**: Very low. Entirely handled in the SQLite layer via schema definitions; `T0Writer` remains completely untouched.
- **Query semantics fit**: Ideal. Tokenization, case-insensitivity, and fast ranking match the exact needs of lexical recall.

## Option B — Trigram side-table
- **Pros**: Perfectly matches infix code symbol searches (e.g., finding `Reader` inside `RecallReader`).
- **Cons**: Standard SQLite does not have a native trigram index extension (outside of FTS5). Implementing this manually requires a custom side-table, application-level text chunking in TS, and complex `LIKE '%foo%'` intersection queries.
- **Code-cost**: High. `T0Writer` in `packages/core/src/writers/t0.ts` would need a new indexing pass on every write, adding latency and complexity.
- **Query semantics fit**: Overkill and sub-optimal for natural language (chat messages, summaries) compared to FTS5's BM25.

## Decision Drivers
- **Volume / Write Overhead**: At ~13,460 total `t0_events` in the live DB, and generating 5-50 events per dispatch, the insert overhead of an FTS5 trigger is mathematically invisible (<1ms).
- **Migration Cost**: Backfilling 13.5k rows in SQLite takes milliseconds. The migration is safe and fast.
- **Maintenance Cost**: FTS5 delegates all indexing complexity to SQLite. Option B would introduce custom TS logic that we have to test and maintain.
- **Query Semantics**: FTS5 ranking provides a score (`bm25()`) which allows `queryT0` to return an ordered list, perfectly setting up the handoff to the pure `fuseRRF` helper (Commit 2).

## Recommended Wave 5 Commit 1 Outline
- Introduce schema migration to create the virtual table:
  ```sql
  CREATE VIRTUAL TABLE t0_fts USING fts5(content, event_id UNINDEXED);
  ```
- Add `INSERT` and `UPDATE` triggers on `t0_events` to populate `t0_fts`. Use SQLite JSON functions (e.g., `json_extract(new.payload_json, '$.message')` or a coalesced string of text fields) to avoid indexing JSON braces and punctuation.
- Include a backfill step in the migration:
  ```sql
  INSERT INTO t0_fts (rowid, content, event_id)
  SELECT rowid, json_extract(payload_json, '$.message'), event_id FROM t0_events;
  ```
- Implement `queryT0` inside `packages/core/src/readers/recall.ts` that runs a `MATCH` query, extracts the `bm25(t0_fts)` score, and returns the top-K mapped `RecallResult` objects to be merged in Commit 3.
