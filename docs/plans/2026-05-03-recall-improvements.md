# Recall Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the high-leverage memory/recall capabilities from the claude-mem fork (`/Volumes/WorkSSD/repos/personal/claude-mem`) and adapt them onto penumbra's existing t0/t1/t2 tier model — so recall becomes typed, file-aware, deterministically filterable, and offers a token-efficient 3-layer (index → timeline → fetch) workflow on par with claude-mem's `mem-search` skill, plus knowledge-corpora and a status surface.

**Architecture:** Six phases, each shippable on its own. Phase 1 promotes opaque metadata fields to first-class indexed columns and adds FTS5 indexes over t1/t2. Phase 2 adds a trigger-populated file-reference index over t0. Phase 3 layers three new MCP tools (`memory.search`, `memory.timeline`, `memory.get_observations`) on top. Phase 4 introduces a pluggable hybrid orchestrator (filter → vector rerank → SQL hydrate). Phase 5 adds knowledge corpora (filtered observation bundles queryable as topical RAG). Phase 6 exposes a recall-pipeline status MCP tool. All schema migrations are additive (`addColumnIfMissing` / `CREATE … IF NOT EXISTS`); existing data is backfilled in dedicated scripts. The tier model, RRF fusion, and embedder interface stay as-is.

**Tech Stack:** Bun + TypeScript, `bun:sqlite` with FTS5 + sqlite-vec virtual tables, zod schemas, `bun test`. Existing modules: `packages/core/src/{db,readers,writers,schemas}`, `packages/daemon/src/{routes,workers}`, `packages/mcp/src/{server,tools,daemon-client}`, `packages/cli/src/commands`.

---

## Pre-flight

- [ ] **Read these files for context before starting**

```
packages/core/src/db/schema.ts                  # applySchema, addColumnIfMissing, virtual tables
packages/core/src/db/migrations.ts              # migrate() — test entry that wraps applySchema + db_meta
packages/core/src/db/sqlite-vec.ts              # loadSqliteVec helper
packages/core/src/schemas/recall.ts             # RecallRequest/Result zod
packages/core/src/readers/recall.ts             # RecallReader + RRF fusion
packages/core/src/writers/{t0,t1,t2}.ts         # write paths
packages/daemon/src/routes/recall.ts            # HTTP /memory/recall
packages/daemon/src/workers/{t1-rollup,t2-promotion}.ts
packages/mcp/src/server.ts                      # tool registration
packages/mcp/src/tools/recall.ts                # InputShape/handler pattern
packages/mcp/src/daemon-client.ts               # daemon RPC client
packages/agentchat/src/worker/recall-enricher.ts # per-agent recall_context
packages/core/test/readers/recall.test.ts       # test boilerplate template (sqlite-vec preamble)
```

### Test file boilerplate (REQUIRED for every new test file)

Every new test file in `packages/core/test/**` that creates a `Database` MUST start with this preamble. On macOS, Bun uses Apple's SQLite which disables `loadExtension`; without this switch, `loadSqliteVec` will fail and `applySchema` blows up at the `vec0` virtual table.

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';

// Switch to Homebrew's full-featured SQLite before any Database is created.
// Guard against double-load when multiple test files run in the same process.
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded
}
```

Then in each test:

```ts
const db = new Database(':memory:');
loadSqliteVec(db);
migrate(db, { embeddingDim: 4 });
```

**Do NOT call `ensureSchema(...)` — that name does not exist.** `migrate` is the test entry; it wraps the internal `applySchema`.

- [ ] **Run the existing memory test suite to confirm the baseline is green**

```bash
bun test packages/core/test/readers packages/core/test/writers packages/daemon/test/recall.test.ts packages/mcp/test/recall.test.ts
```

Expected: all pass.

---

## Phase 1 — First-class typed/concept/severity columns + t1/t2 FTS

### File Structure

- Modify: `packages/core/src/db/schema.ts` (add columns, virtual tables, triggers)
- Create: `packages/core/test/db/schema-recall-fields.test.ts` (column-presence + FTS-row-count tests)
- Create: `packages/core/src/db/backfill-recall-fields.ts` (one-shot backfill from `metadata_json` + emoji titles)
- Create: `packages/core/test/db/backfill-recall-fields.test.ts`
- Modify: `packages/core/src/schemas/memory.ts` (`T2MemoryRecord` adds `obs_type`, `concepts`, `severity`)
- Modify: `packages/core/src/writers/t2.ts` (write new columns; default-fill from metadata)
- Modify: `packages/core/src/writers/t1.ts` (no schema change but populate new t1_fts on insert)
- Add CLI: `packages/cli/src/commands/recall-backfill.ts` registered in `packages/cli/bin/penumbra.ts`

### Task 1.1: Test — t2_memories has obs_type/concepts/severity columns

**Files:**
- Create: `packages/core/test/db/schema-recall-fields.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/db/schema-recall-fields.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded
}

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 4 });
  return db;
}

describe('recall schema enrichment', () => {
  test('t2_memories carries first-class obs_type, concepts, severity', () => {
    const db = freshDb();
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(t2_memories)`)
      .all()
      .map((r) => r.name);
    expect(cols).toContain('obs_type');
    expect(cols).toContain('concepts');
    expect(cols).toContain('severity');
    expect(cols).toContain('file_paths');
  });

  test('t1_fts and t2_fts virtual tables exist', () => {
    const db = freshDb();
    const t1 = db
      .query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get('t1_fts');
    const t2 = db
      .query<{ name: string }, [string]>(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get('t2_fts');
    expect(t1?.name).toBe('t1_fts');
    expect(t2?.name).toBe('t2_fts');
  });

  test('idx_t2_obs_type and idx_t2_severity exist', () => {
    const db = freshDb();
    const idx = db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='t2_memories'`)
      .all()
      .map((r) => r.name);
    expect(idx).toContain('idx_t2_obs_type');
    expect(idx).toContain('idx_t2_severity');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test packages/core/test/db/schema-recall-fields.test.ts
```

Expected: FAIL — columns/indexes/virtual-tables not present.

### Task 1.2: Schema — add columns + FTS5 + indexes

**Files:**
- Modify: `packages/core/src/db/schema.ts` (additive section after the existing `t2_memories` block and after the `t0_fts` block)

- [ ] **Step 1: Add the new columns and indexes via additive migration**

Locate the `// Additive migration for t1_rollups` section in `schema.ts`. Add immediately after it:

```ts
    // Additive migration for t2_memories — promote opaque metadata to first-class
    // columns so recall can filter without parsing JSON.
    addColumnIfMissing(db, 't2_memories', 'obs_type', 'TEXT');
    addColumnIfMissing(db, 't2_memories', 'concepts', 'TEXT'); // JSON array, FTS-indexed below
    addColumnIfMissing(db, 't2_memories', 'severity', 'TEXT'); // 'info' | 'warn' | 'error' | NULL
    addColumnIfMissing(db, 't2_memories', 'file_paths', 'TEXT'); // JSON array of repo-relative paths
    db.exec(`CREATE INDEX IF NOT EXISTS idx_t2_obs_type ON t2_memories(obs_type) WHERE obs_type IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_t2_severity ON t2_memories(severity) WHERE severity IS NOT NULL`);
```

Then locate the `t0_fts` virtual-table block; add immediately after the `t0_fts` triggers:

```ts
    // t1_fts — keyword index over per-session prompt + summary excerpts so
    // "what was I asking about ACP" becomes a deterministic query.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS t1_fts USING fts5(
        first_prompt_excerpt,
        last_response_excerpt,
        tool_calls_summary,
        content='t1_rollups',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS t1_fts_insert AFTER INSERT ON t1_rollups BEGIN
        INSERT INTO t1_fts (rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES (new.rowid, new.first_prompt_excerpt, new.last_response_excerpt, new.tool_calls_summary);
      END;
      CREATE TRIGGER IF NOT EXISTS t1_fts_delete AFTER DELETE ON t1_rollups BEGIN
        INSERT INTO t1_fts (t1_fts, rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES ('delete', old.rowid, old.first_prompt_excerpt, old.last_response_excerpt, old.tool_calls_summary);
      END;
      CREATE TRIGGER IF NOT EXISTS t1_fts_update AFTER UPDATE ON t1_rollups BEGIN
        INSERT INTO t1_fts (t1_fts, rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES ('delete', old.rowid, old.first_prompt_excerpt, old.last_response_excerpt, old.tool_calls_summary);
        INSERT INTO t1_fts (rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
        VALUES (new.rowid, new.first_prompt_excerpt, new.last_response_excerpt, new.tool_calls_summary);
      END;
    `);

    // t2_fts — multi-field FTS over the title/body and the new typed metadata.
    // Query like FTS5: t2_fts MATCH 'title:codex OR concepts:acp'
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS t2_fts USING fts5(
        title,
        body,
        obs_type,
        concepts,
        file_paths,
        content='t2_memories',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS t2_fts_insert AFTER INSERT ON t2_memories BEGIN
        INSERT INTO t2_fts (rowid, title, body, obs_type, concepts, file_paths)
        VALUES (new.rowid, new.title, new.body, new.obs_type, new.concepts, new.file_paths);
      END;
      CREATE TRIGGER IF NOT EXISTS t2_fts_delete AFTER DELETE ON t2_memories BEGIN
        INSERT INTO t2_fts (t2_fts, rowid, title, body, obs_type, concepts, file_paths)
        VALUES ('delete', old.rowid, old.title, old.body, old.obs_type, old.concepts, old.file_paths);
      END;
      CREATE TRIGGER IF NOT EXISTS t2_fts_update AFTER UPDATE ON t2_memories BEGIN
        INSERT INTO t2_fts (t2_fts, rowid, title, body, obs_type, concepts, file_paths)
        VALUES ('delete', old.rowid, old.title, old.body, old.obs_type, old.concepts, old.file_paths);
        INSERT INTO t2_fts (rowid, title, body, obs_type, concepts, file_paths)
        VALUES (new.rowid, new.title, new.body, new.obs_type, new.concepts, new.file_paths);
      END;
    `);
```

Note: `t1_rollups` doesn't have an explicit `rowid` column declared, but SQLite auto-provides one for non-WITHOUT-ROWID tables. The `content_rowid='rowid'` clause makes the FTS5 view a contentless mirror.

- [ ] **Step 2: Run the schema test to verify it passes**

```bash
bun test packages/core/test/db/schema-recall-fields.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full memory suite to verify no regression**

```bash
bun test packages/core/test/readers packages/core/test/writers packages/core/test/db
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/schema-recall-fields.test.ts
git commit -m "feat(memory): promote obs_type/concepts/severity/file_paths on t2_memories; add t1_fts and t2_fts"
```

### Task 1.3: Test — T2 writer populates new columns

**Files:**
- Create: `packages/core/test/writers/t2-typed-fields.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/writers/t2-typed-fields.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { writeT2Memory } from '../../src/writers/t2.js';

describe('T2 writer typed-fields support', () => {
  test('explicit obs_type/concepts/severity/file_paths land on the row', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    await writeT2Memory(db, {
      memory_id: 'm1',
      project_id: 'penumbra',
      user_id: 'u',
      kind: 'rollup',
      source_session_ids: [],
      window_start: '2026-05-03T00:00:00Z',
      window_end:   '2026-05-03T00:00:00Z',
      title: 'codex-acp tool wiring',
      body: 'fs/terminal caps wired',
      embedding: new Float32Array([0, 0, 0, 1]),
      obs_type: 'feature',
      concepts: ['acp', 'codex'],
      severity: null,
      file_paths: ['agentchat.yaml'],
    });
    const row = db
      .query<{ obs_type: string; concepts: string; severity: string | null; file_paths: string }, [string]>(
        `SELECT obs_type, concepts, severity, file_paths FROM t2_memories WHERE memory_id=?`,
      )
      .get('m1');
    expect(row?.obs_type).toBe('feature');
    expect(JSON.parse(row!.concepts)).toEqual(['acp', 'codex']);
    expect(row?.severity).toBeNull();
    expect(JSON.parse(row!.file_paths)).toEqual(['agentchat.yaml']);
  });

  test('omitted typed fields fall back to NULL / [] without throwing', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    await writeT2Memory(db, {
      memory_id: 'm2',
      project_id: null,
      user_id: 'u',
      kind: 'rollup',
      source_session_ids: [],
      window_start: '2026-05-03T00:00:00Z',
      window_end:   '2026-05-03T00:00:00Z',
      title: 't',
      body: 'b',
      embedding: new Float32Array([0, 0, 0, 1]),
    });
    const row = db
      .query<{ obs_type: string | null; concepts: string | null; severity: string | null; file_paths: string | null }, [string]>(
        `SELECT obs_type, concepts, severity, file_paths FROM t2_memories WHERE memory_id=?`,
      )
      .get('m2');
    expect(row?.obs_type).toBeNull();
    expect(JSON.parse(row?.concepts ?? '[]')).toEqual([]);
    expect(row?.severity).toBeNull();
    expect(JSON.parse(row?.file_paths ?? '[]')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test packages/core/test/writers/t2-typed-fields.test.ts
```

Expected: FAIL — `writeT2Memory` doesn't accept those fields and the columns aren't populated.

### Task 1.4: Implement — wire typed fields through T2 schema + writer

**Files:**
- Modify: `packages/core/src/schemas/memory.ts` (add fields to T2MemoryRecord and a runtime guard)
- Modify: `packages/core/src/writers/t2.ts` (accept fields, default-fill, write to columns)

- [ ] **Step 1: Extend the zod schema in `packages/core/src/schemas/memory.ts`**

Locate the `T2MemoryRecord` schema (or its writer-input schema). Add:

```ts
export const ObsTypeEnum = z
  .enum(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change', 'security_alert', 'security_note', 'session', 'other'])
  .optional()
  .nullable();

export const SeverityEnum = z.enum(['info', 'warn', 'error']).optional().nullable();

// Append to the T2MemoryWriteInput object:
//   obs_type:   ObsTypeEnum,
//   concepts:   z.array(z.string()).optional().default([]),
//   severity:   SeverityEnum,
//   file_paths: z.array(z.string()).optional().default([]),
```

If the existing schema is exported as a single object, add the four fields inline. Match the surrounding style.

- [ ] **Step 2: Update `packages/core/src/writers/t2.ts`**

Find the `INSERT INTO t2_memories(...)` SQL. Extend the column list and bindings:

```ts
db.run(
  `INSERT INTO t2_memories(
     memory_id, project_id, user_id, kind, source_session_ids,
     window_start, window_end, title, body, metadata_json,
     compressed_from, created_at, updated_at,
     obs_type, concepts, severity, file_paths
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    rec.memory_id,
    rec.project_id ?? null,
    rec.user_id,
    rec.kind,
    JSON.stringify(rec.source_session_ids ?? []),
    rec.window_start,
    rec.window_end,
    rec.title,
    rec.body,
    JSON.stringify(rec.metadata ?? {}),
    rec.compressed_from ?? null,
    now,
    now,
    rec.obs_type ?? null,
    JSON.stringify(rec.concepts ?? []),
    rec.severity ?? null,
    JSON.stringify(rec.file_paths ?? []),
  ],
);
```

- [ ] **Step 3: Run T2 tests to verify the new fields land**

```bash
bun test packages/core/test/writers/t2-typed-fields.test.ts packages/core/test/writers/t2.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/schemas/memory.ts packages/core/src/writers/t2.ts packages/core/test/writers/t2-typed-fields.test.ts
git commit -m "feat(memory): T2 writer accepts obs_type/concepts/severity/file_paths"
```

### Task 1.5: Test — backfill from metadata_json + emoji titles

**Files:**
- Create: `packages/core/test/db/backfill-recall-fields.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/db/backfill-recall-fields.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { backfillRecallFields } from '../../src/db/backfill-recall-fields.js';

describe('backfillRecallFields', () => {
  test('emoji-prefixed titles map to obs_type', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const samples = [
      ['🔴 Bug in foo', 'bugfix'],
      ['🟣 New feature bar', 'feature'],
      ['🔄 Refactor baz', 'refactor'],
      ['✅ Updated quux', 'change'],
      ['🔵 Discovery about ACP', 'discovery'],
      ['⚖️ Decided on RRF', 'decision'],
      ['🚨 Credential leak audit', 'security_alert'],
      ['🔐 Hardened gemini-acp env', 'security_note'],
      ['🎯 Session continuation', 'session'],
      ['No prefix at all', null],
    ];
    let i = 0;
    for (const [title] of samples) {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', ?, '', '{}', '2026-05-03', '2026-05-03')`,
        [`m${i++}`, title],
      );
    }

    const stats = backfillRecallFields(db);
    expect(stats.t2_obs_type_set).toBe(samples.filter((s) => s[1] !== null).length);

    const rows = db
      .query<{ memory_id: string; obs_type: string | null }, []>(
        `SELECT memory_id, obs_type FROM t2_memories ORDER BY memory_id`,
      )
      .all();
    expect(rows.map((r) => r.obs_type)).toEqual(samples.map((s) => s[1]));
  });

  test('metadata_json.concepts[] is hoisted into concepts column', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
       VALUES ('m1', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', '✅ x', 'b', ?, '2026-05-03', '2026-05-03')`,
      [JSON.stringify({ concepts: ['acp', 'codex'] })],
    );
    backfillRecallFields(db);
    const row = db
      .query<{ concepts: string }, []>(`SELECT concepts FROM t2_memories WHERE memory_id='m1'`)
      .get();
    expect(JSON.parse(row!.concepts)).toEqual(['acp', 'codex']);
  });

  test('is idempotent — second run does not flip already-set fields', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type)
       VALUES ('m1', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', '✅ x', 'b', '{}', '2026-05-03', '2026-05-03', 'feature')`,
    );
    const first = backfillRecallFields(db);
    const second = backfillRecallFields(db);
    expect(first.t2_obs_type_set).toBe(0); // already set; emoji says 'change' but obs_type='feature' wins
    expect(second.t2_obs_type_set).toBe(0);
    const row = db
      .query<{ obs_type: string }, []>(`SELECT obs_type FROM t2_memories WHERE memory_id='m1'`)
      .get();
    expect(row?.obs_type).toBe('feature');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test packages/core/test/db/backfill-recall-fields.test.ts
```

Expected: FAIL — module does not exist.

### Task 1.6: Implement — backfill module

**Files:**
- Create: `packages/core/src/db/backfill-recall-fields.ts`

- [ ] **Step 1: Implement the backfill module**

```ts
// packages/core/src/db/backfill-recall-fields.ts
import type { Database } from 'bun:sqlite';

const EMOJI_TO_OBS_TYPE: Array<[string, string]> = [
  ['🔴', 'bugfix'],
  ['🟣', 'feature'],
  ['🔄', 'refactor'],
  ['✅', 'change'],
  ['🔵', 'discovery'],
  ['⚖️', 'decision'],
  ['🚨', 'security_alert'],
  ['🔐', 'security_note'],
  ['🎯', 'session'],
];

function emojiToObsType(title: string): string | null {
  const stripped = title.trim();
  for (const [emoji, kind] of EMOJI_TO_OBS_TYPE) {
    if (stripped.startsWith(emoji)) return kind;
  }
  return null;
}

export interface BackfillStats {
  t2_obs_type_set: number;
  t2_concepts_set: number;
  t2_severity_set: number;
  t2_file_paths_set: number;
}

export function backfillRecallFields(db: Database): BackfillStats {
  const stats: BackfillStats = {
    t2_obs_type_set: 0,
    t2_concepts_set: 0,
    t2_severity_set: 0,
    t2_file_paths_set: 0,
  };

  const rows = db
    .query<
      { memory_id: string; title: string; metadata_json: string; obs_type: string | null; concepts: string | null; severity: string | null; file_paths: string | null },
      []
    >(`SELECT memory_id, title, metadata_json, obs_type, concepts, severity, file_paths FROM t2_memories`)
    .all();

  const updateStmt = db.prepare(
    `UPDATE t2_memories SET obs_type=?, concepts=?, severity=?, file_paths=? WHERE memory_id=?`,
  );

  for (const row of rows) {
    let meta: { concepts?: string[]; severity?: string; file_paths?: string[] } = {};
    try {
      meta = JSON.parse(row.metadata_json || '{}');
    } catch {
      meta = {};
    }

    let obsType = row.obs_type;
    if (!obsType) {
      obsType = emojiToObsType(row.title);
      if (obsType) stats.t2_obs_type_set += 1;
    }

    let concepts = row.concepts;
    if (!concepts || concepts === '[]') {
      const fromMeta = Array.isArray(meta.concepts) ? meta.concepts : [];
      if (fromMeta.length > 0) {
        concepts = JSON.stringify(fromMeta);
        stats.t2_concepts_set += 1;
      } else if (concepts === null) {
        concepts = '[]';
      }
    }

    let severity = row.severity;
    if (!severity && typeof meta.severity === 'string') {
      severity = meta.severity;
      stats.t2_severity_set += 1;
    }

    let filePaths = row.file_paths;
    if (!filePaths || filePaths === '[]') {
      const fromMeta = Array.isArray(meta.file_paths) ? meta.file_paths : [];
      if (fromMeta.length > 0) {
        filePaths = JSON.stringify(fromMeta);
        stats.t2_file_paths_set += 1;
      } else if (filePaths === null) {
        filePaths = '[]';
      }
    }

    updateStmt.run(obsType ?? null, concepts ?? '[]', severity ?? null, filePaths ?? '[]', row.memory_id);
  }

  return stats;
}
```

- [ ] **Step 2: Run the backfill test**

```bash
bun test packages/core/test/db/backfill-recall-fields.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/db/backfill-recall-fields.ts packages/core/test/db/backfill-recall-fields.test.ts
git commit -m "feat(memory): backfill obs_type/concepts/severity/file_paths from metadata + emoji titles"
```

### Task 1.7: CLI — `penumbra recall-backfill` one-shot

**Files:**
- Create: `packages/cli/src/commands/recall-backfill.ts`
- Modify: `packages/cli/bin/penumbra.ts` (register subcommand)

- [ ] **Step 1: Add the CLI command**

```ts
// packages/cli/src/commands/recall-backfill.ts
import { Database } from 'bun:sqlite';
import { resolveStorageRoot } from '@penumbra/core/identity';
import { join } from 'node:path';
import { backfillRecallFields } from '@penumbra/core/db/backfill-recall-fields';

export async function runRecallBackfill(): Promise<number> {
  const root = resolveStorageRoot();
  const dbPath = join(root, 'penumbra.db');
  const db = new Database(dbPath);
  try {
    const stats = backfillRecallFields(db);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return 0;
  } finally {
    db.close();
  }
}
```

Adjust the imports for whatever path-conventions the existing CLI commands use; the patterns in `packages/cli/src/commands/recall.ts` are authoritative.

- [ ] **Step 2: Wire the command in `packages/cli/bin/penumbra.ts`**

Find the existing dispatch on subcommand name (similar to `recall`). Add:

```ts
case 'recall-backfill':
  process.exit(await runRecallBackfill());
```

- [ ] **Step 3: Smoke-run it on the live DB (read-only check first via SELECT)**

```bash
sqlite3 ~/.penumbra/penumbra.db "SELECT COUNT(*) FROM t2_memories" # baseline count
PENUMBRA_STORAGE_ROOT=~/.penumbra bun packages/cli/bin/penumbra.ts recall-backfill
sqlite3 ~/.penumbra/penumbra.db "SELECT obs_type, COUNT(*) FROM t2_memories GROUP BY obs_type ORDER BY 2 DESC"
```

Expected: stats JSON > 0 for fields that needed populating; the GROUP BY shows distribution across `bugfix/feature/refactor/change/discovery/decision/security_*/session/NULL`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/recall-backfill.ts packages/cli/bin/penumbra.ts
git commit -m "feat(cli): penumbra recall-backfill — populate t2 typed fields from history"
```

---

## Phase 2 — t0_file_refs trigger-populated index + by-file recall

### File Structure

- Modify: `packages/core/src/db/schema.ts` (add `t0_file_refs` table + INSERT trigger over t0_events)
- Modify: `packages/core/src/readers/recall.ts` (add `byFile` SQL helper)
- Modify: `packages/core/src/schemas/recall.ts` (add `file_path` field to RecallRequest)
- Create: `packages/core/test/readers/recall-by-file.test.ts`

### Task 2.1: Test — t0_file_refs is populated by trigger

**Files:**
- Create: `packages/core/test/db/t0-file-refs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/db/t0-file-refs.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

describe('t0_file_refs trigger', () => {
  test('Edit/Write/Read tool calls produce one row per file_path in payload', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const editPayload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: 'packages/core/src/db/schema.ts' },
    });
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
       VALUES ('e1', '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'tool_use', 'tool', ?)`,
      [editPayload],
    );
    const refs = db
      .query<{ event_id: string; file_path: string }, []>(`SELECT event_id, file_path FROM t0_file_refs`)
      .all();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ event_id: 'e1', file_path: 'packages/core/src/db/schema.ts' });
  });

  test('events without file_path produce no rows', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
       VALUES ('e2', '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'agent_thought', 'thought', '{"text":"thinking"}')`,
    );
    const count = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t0_file_refs`).get();
    expect(count?.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test packages/core/test/db/t0-file-refs.test.ts
```

Expected: FAIL — `t0_file_refs` doesn't exist.

### Task 2.2: Schema — t0_file_refs + INSERT trigger using json_extract

**Files:**
- Modify: `packages/core/src/db/schema.ts`

- [ ] **Step 1: Add the table + trigger after the t0_fts block**

```ts
    db.exec(`
      CREATE TABLE IF NOT EXISTS t0_file_refs (
        event_id   TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        PRIMARY KEY (event_id, file_path),
        FOREIGN KEY (event_id) REFERENCES t0_events(event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_t0_file_refs_path  ON t0_file_refs(file_path);
      CREATE INDEX IF NOT EXISTS idx_t0_file_refs_event ON t0_file_refs(event_id);

      -- Trigger extracts file_path from common claude-code/codex/opencode tool payload shapes.
      -- Single-file shape: { tool_input: { file_path: "..." } }
      -- We deliberately keep this narrow; multi-file extraction comes via the writer path
      -- when it has explicit knowledge of the schema.
      CREATE TRIGGER IF NOT EXISTS t0_file_refs_insert AFTER INSERT ON t0_events
      WHEN json_extract(new.payload_json, '$.tool_input.file_path') IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO t0_file_refs(event_id, file_path)
        VALUES (new.event_id, json_extract(new.payload_json, '$.tool_input.file_path'));
      END;
    `);
```

- [ ] **Step 2: Verify the trigger test passes**

```bash
bun test packages/core/test/db/t0-file-refs.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/t0-file-refs.test.ts
git commit -m "feat(memory): trigger-populated t0_file_refs index for by-file recall"
```

### Task 2.3: Test — recall accepts `file_path` filter

**Files:**
- Create: `packages/core/test/readers/recall-by-file.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/readers/recall-by-file.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { RecallReader } from '../../src/readers/recall.js';
import { fakeEmbedder } from '../../src/embedder/fake.js'; // same fixture used by other recall tests

describe('RecallReader by-file scoping', () => {
  test('file_path filter restricts t0 hits to events that touched that path', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, file: string | null, content: string) =>
      db.run(
        `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
         VALUES (?, '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'tool_use', 'tool', ?)`,
        [id, JSON.stringify(file ? { tool_input: { file_path: file }, text: content } : { text: content })],
      );
    insert('e1', 'agentchat.yaml', 'edited haiku entry');
    insert('e2', 'README.md', 'edited readme');
    insert('e3', null, 'unrelated thought');

    const reader = new RecallReader({ db, embedder: fakeEmbedder() });
    const out = await reader.recall({
      query: 'edited',
      project_id: null,
      limit: 10,
      include_raw: true,
      sources: ['t0'],
      min_score: 0,
      file_path: 'agentchat.yaml',
    });
    const ids = out.map((r) => r.event_id ?? r.memory_id ?? '');
    expect(ids).toContain('e1');
    expect(ids).not.toContain('e2');
    expect(ids).not.toContain('e3');
  });
});
```

If `fakeEmbedder` doesn't exist, copy whatever construction the sibling test files (`recall-t0.test.ts`) use.

- [ ] **Step 2: Confirm failure**

```bash
bun test packages/core/test/readers/recall-by-file.test.ts
```

Expected: FAIL — `RecallRequest` does not accept `file_path`.

### Task 2.4: Implement — file_path scoping in recall

**Files:**
- Modify: `packages/core/src/schemas/recall.ts`
- Modify: `packages/core/src/readers/recall.ts`

- [ ] **Step 1: Extend the schema**

In `recall.ts` (schema), add `file_path: z.string().optional()` to `RecallRequestSchema`.

- [ ] **Step 2: Extend `queryT0` in `packages/core/src/readers/recall.ts`**

Locate the `queryT0` function. Where it builds the WHERE clause, add a clause when `file_path` is set:

```ts
const fileJoin = req.file_path
  ? `INNER JOIN t0_file_refs r ON r.event_id = e.event_id AND r.file_path = ?`
  : '';
// ...
const params: unknown[] = [req.query, ...]; // existing
if (req.file_path) params.unshift(req.file_path); // bind for the JOIN
```

The exact JOIN placement depends on how `queryT0` is structured — read the existing function and slot the JOIN before the `WHERE` so the file scope is part of the candidate set, not a post-filter.

- [ ] **Step 3: Verify the test passes**

```bash
bun test packages/core/test/readers/recall-by-file.test.ts packages/core/test/readers/recall-t0.test.ts packages/core/test/readers/recall.test.ts
```

Expected: PASS.

- [ ] **Step 4: Surface the param at the MCP and CLI layers**

In `packages/mcp/src/tools/recall.ts`:

```ts
export const RecallInputShape = {
  query: z.string().min(1),
  project_id: z.string().nullable().optional(),
  limit: z.number().int().positive().max(200).optional(),
  include_raw: z.boolean().optional(),
  min_score: z.number().min(0).max(1).optional(),
  session_id: z.string().optional(),
  event_types: z.array(z.string()).optional(),
  file_path: z.string().optional().describe('Restrict t0 results to events that touched this file path.'),
};
```

In `packages/cli/src/commands/recall.ts`, add a `--file <path>` CLI flag that sets `file_path` on the request.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas/recall.ts packages/core/src/readers/recall.ts packages/mcp/src/tools/recall.ts packages/cli/src/commands/recall.ts packages/core/test/readers/recall-by-file.test.ts
git commit -m "feat(memory): by-file recall scoping via t0_file_refs index"
```

---

## Phase 3 — 3-layer search MCP tools

### File Structure

- Modify: `packages/core/src/schemas/recall.ts` (add `SearchRequest`, `TimelineRequest`, `GetObservationsRequest` zod schemas + result types)
- Create: `packages/core/src/readers/search.ts` (compact-index search across t1/t2 with FTS5 + filters)
- Create: `packages/core/src/readers/timeline.ts` (chronological neighbors around an anchor)
- Create: `packages/core/src/readers/get-observations.ts` (batch hydrate by IDs)
- Create: `packages/core/test/readers/search.test.ts`
- Create: `packages/core/test/readers/timeline.test.ts`
- Create: `packages/core/test/readers/get-observations.test.ts`
- Modify: `packages/daemon/src/routes/recall.ts` (split into `routes/memory.ts` exposing `/memory/search`, `/memory/timeline`, `/memory/get`)
- Modify: `packages/daemon/src/serve.ts` (register the new routes)
- Create: `packages/mcp/src/tools/search.ts`
- Create: `packages/mcp/src/tools/timeline.ts`
- Create: `packages/mcp/src/tools/get-observations.ts`
- Modify: `packages/mcp/src/server.ts` (register the three new tools)
- Modify: `packages/mcp/src/daemon-client.ts` (add three RPC wrappers)

### Task 3.1: Test — `search` returns compact rows with IDs and short snippets

**Files:**
- Create: `packages/core/test/readers/search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/readers/search.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { search } from '../../src/readers/search.js';

describe('search (compact index)', () => {
  test('returns id, tier, ts, type, title, snippet for each hit', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type, concepts)
       VALUES ('m1', 'penumbra', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 'codex-acp tool wiring', 'fs/terminal caps wired', '{}', '2026-05-03', '2026-05-03', 'feature', '["acp","codex"]')`,
    );
    const out = search(db, { query: 'codex', limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'm1',
      tier: 't2',
      obs_type: 'feature',
      title: 'codex-acp tool wiring',
    });
    expect(typeof out[0].snippet).toBe('string');
    expect(out[0].snippet.length).toBeGreaterThan(0);
    expect(out[0].snippet.length).toBeLessThan(200); // compact!
  });

  test('obs_type filter narrows results', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, title: string, type: string) =>
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', ?, 'b', '{}', '2026-05-03', '2026-05-03', ?)`,
        [id, title, type],
      );
    insert('a', 'fix codex', 'bugfix');
    insert('b', 'add codex', 'feature');
    const out = search(db, { query: 'codex', limit: 10, obs_type: 'bugfix' });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  test('date range narrows results', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
       VALUES ('m_old', 'u', 'rollup', '[]', '2026-04-01', '2026-04-01', 'old hit', 'x', '{}', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    );
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
       VALUES ('m_new', 'u', 'rollup', '[]', '2026-05-01', '2026-05-01', 'new hit', 'x', '{}', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`,
    );
    const out = search(db, { query: 'hit', limit: 10, dateStart: '2026-05-01' });
    expect(out.map((r) => r.id)).toEqual(['m_new']);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
bun test packages/core/test/readers/search.test.ts
```

Expected: FAIL — `search` doesn't exist.

### Task 3.2: Implement — search reader

**Files:**
- Create: `packages/core/src/readers/search.ts`
- Modify: `packages/core/src/schemas/recall.ts` (add `SearchRequestSchema`, `SearchHit`)

- [ ] **Step 1: Add the schemas**

```ts
// in packages/core/src/schemas/recall.ts
export const SearchRequestSchema = z.object({
  query:      z.string().min(1),
  project_id: z.string().nullable().optional(),
  limit:      z.number().int().positive().max(200).default(20),
  obs_type:   z.string().optional(),
  concept:    z.string().optional(),
  file_path:  z.string().optional(),
  dateStart:  z.string().optional(), // ISO; matched against created_at >=
  dateEnd:    z.string().optional(), // ISO; matched against created_at <=
  tiers:      z.array(z.enum(['t1', 't2'])).optional().default(['t1', 't2']),
  offset:     z.number().int().min(0).optional().default(0),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export interface SearchHit {
  id: string;       // event_id | rollup_id | memory_id
  tier: 't1' | 't2';
  ts: string;
  obs_type?: string | null;
  title: string;
  snippet: string;  // ~120 chars
  project_id: string | null;
  score: number;    // FTS5 bm25 score, lower=better; we invert
}
```

- [ ] **Step 2: Implement the reader**

```ts
// packages/core/src/readers/search.ts
import type { Database } from 'bun:sqlite';
import type { SearchRequest, SearchHit } from '../schemas/recall.js';

const SNIPPET_LEN = 120;

function snippetFromBody(body: string): string {
  return body.length <= SNIPPET_LEN ? body : `${body.slice(0, SNIPPET_LEN - 1).trim()}…`;
}

export function search(db: Database, req: SearchRequest): SearchHit[] {
  const tiers = req.tiers ?? ['t1', 't2'];
  const hits: SearchHit[] = [];

  if (tiers.includes('t2')) {
    const where: string[] = ['t2_fts MATCH ?'];
    const params: unknown[] = [req.query];

    if (req.project_id !== undefined) {
      if (req.project_id === null) where.push('m.project_id IS NULL');
      else { where.push('m.project_id = ?'); params.push(req.project_id); }
    }
    if (req.obs_type)  { where.push('m.obs_type = ?');                    params.push(req.obs_type); }
    if (req.concept)   { where.push("m.concepts LIKE '%' || ? || '%'");   params.push(req.concept); }
    if (req.file_path) { where.push("m.file_paths LIKE '%' || ? || '%'"); params.push(req.file_path); }
    if (req.dateStart) { where.push('m.created_at >= ?');                 params.push(req.dateStart); }
    if (req.dateEnd)   { where.push('m.created_at <= ?');                 params.push(req.dateEnd); }

    const sql = `
      SELECT m.memory_id AS id, m.created_at AS ts, m.obs_type AS obs_type, m.title AS title,
             m.body AS body, m.project_id AS project_id, bm25(t2_fts) AS score
        FROM t2_fts JOIN t2_memories m ON m.rowid = t2_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY score
       LIMIT ? OFFSET ?
    `;
    params.push(req.limit, req.offset);

    for (const row of db
      .query<{ id: string; ts: string; obs_type: string | null; title: string; body: string; project_id: string | null; score: number }, unknown[]>(
        sql,
      )
      .all(...params)) {
      hits.push({
        id: row.id,
        tier: 't2',
        ts: row.ts,
        obs_type: row.obs_type,
        title: row.title,
        snippet: snippetFromBody(row.body),
        project_id: row.project_id,
        score: row.score,
      });
    }
  }

  if (tiers.includes('t1')) {
    const where: string[] = ['t1_fts MATCH ?'];
    const params: unknown[] = [req.query];
    if (req.project_id !== undefined) {
      if (req.project_id === null) where.push('r.project_id IS NULL');
      else { where.push('r.project_id = ?'); params.push(req.project_id); }
    }
    if (req.dateStart) { where.push('r.ended_at >= ?'); params.push(req.dateStart); }
    if (req.dateEnd)   { where.push('r.ended_at <= ?'); params.push(req.dateEnd); }
    const sql = `
      SELECT r.rollup_id AS id, r.ended_at AS ts, r.first_prompt_excerpt AS prompt,
             r.last_response_excerpt AS resp, r.project_id AS project_id, bm25(t1_fts) AS score
        FROM t1_fts JOIN t1_rollups r ON r.rowid = t1_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY score
       LIMIT ? OFFSET ?
    `;
    params.push(req.limit, req.offset);
    for (const row of db
      .query<{ id: string; ts: string; prompt: string | null; resp: string | null; project_id: string | null; score: number }, unknown[]>(
        sql,
      )
      .all(...params)) {
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

  // Cross-tier: lower bm25 = better. Stable sort by score, then by ts desc.
  hits.sort((a, b) => (a.score - b.score) || (b.ts.localeCompare(a.ts)));
  return hits.slice(0, req.limit);
}
```

- [ ] **Step 3: Verify**

```bash
bun test packages/core/test/readers/search.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/readers/search.ts packages/core/src/schemas/recall.ts packages/core/test/readers/search.test.ts
git commit -m "feat(memory): compact-index search across t1_fts/t2_fts with filters"
```

### Task 3.3: Test + implement — `timeline` reader

**Files:**
- Create: `packages/core/test/readers/timeline.test.ts`
- Create: `packages/core/src/readers/timeline.ts`

- [ ] **Step 1: Test**

```ts
// packages/core/test/readers/timeline.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { timeline } from '../../src/readers/timeline.js';

describe('timeline (chronological neighbors)', () => {
  test('returns depth_before earlier and depth_after later memories around an anchor', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, ts: string, title: string) =>
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
         VALUES (?, 'u', 'rollup', '[]', ?, ?, ?, '', '{}', ?, ?)`,
        [id, ts, ts, title, ts, ts],
      );
    insert('m1', '2026-05-01T00:00:00Z', 'one');
    insert('m2', '2026-05-02T00:00:00Z', 'two');
    insert('m3', '2026-05-03T00:00:00Z', 'three');
    insert('m4', '2026-05-04T00:00:00Z', 'four');
    insert('m5', '2026-05-05T00:00:00Z', 'five');

    const out = timeline(db, { anchor: 'm3', depth_before: 1, depth_after: 2 });
    expect(out.map((r) => r.id)).toEqual(['m2', 'm3', 'm4', 'm5']);
  });

  test('project_id filter applies before slicing the window', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, ts: string, project: string | null) =>
      db.run(
        `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'u', 'rollup', '[]', ?, ?, ?, '', '{}', ?, ?)`,
        [id, project, ts, ts, id, ts, ts],
      );
    insert('a', '2026-05-01T00:00:00Z', 'penumbra');
    insert('b', '2026-05-02T00:00:00Z', 'other');
    insert('c', '2026-05-03T00:00:00Z', 'penumbra');
    const out = timeline(db, { anchor: 'c', depth_before: 5, depth_after: 0, project_id: 'penumbra' });
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
bun test packages/core/test/readers/timeline.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/readers/timeline.ts
import type { Database } from 'bun:sqlite';

export interface TimelineRequest {
  anchor: string; // memory_id
  depth_before: number;
  depth_after: number;
  project_id?: string | null;
}

export interface TimelineEntry {
  id: string;
  ts: string;
  obs_type: string | null;
  title: string;
}

export function timeline(db: Database, req: TimelineRequest): TimelineEntry[] {
  const anchor = db
    .query<{ created_at: string; project_id: string | null }, [string]>(
      `SELECT created_at, project_id FROM t2_memories WHERE memory_id = ?`,
    )
    .get(req.anchor);
  if (!anchor) return [];

  const projectFilter =
    req.project_id !== undefined
      ? req.project_id === null
        ? 'AND project_id IS NULL'
        : 'AND project_id = ?'
      : '';
  const projectParam = req.project_id !== undefined && req.project_id !== null ? [req.project_id] : [];

  const beforeRows = db
    .query<TimelineEntry, unknown[]>(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title
         FROM t2_memories
        WHERE created_at < ? ${projectFilter}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(anchor.created_at, ...projectParam, req.depth_before)
    .reverse();

  const anchorRow = db
    .query<TimelineEntry, [string]>(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title FROM t2_memories WHERE memory_id = ?`,
    )
    .get(req.anchor);

  const afterRows = db
    .query<TimelineEntry, unknown[]>(
      `SELECT memory_id AS id, created_at AS ts, obs_type, title
         FROM t2_memories
        WHERE created_at > ? ${projectFilter}
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(anchor.created_at, ...projectParam, req.depth_after);

  return [...beforeRows, ...(anchorRow ? [anchorRow] : []), ...afterRows];
}
```

- [ ] **Step 4: Verify + commit**

```bash
bun test packages/core/test/readers/timeline.test.ts
git add packages/core/src/readers/timeline.ts packages/core/test/readers/timeline.test.ts
git commit -m "feat(memory): timeline reader returns chronological neighbors around an anchor"
```

### Task 3.4: Test + implement — `get_observations` batch hydrator

**Files:**
- Create: `packages/core/test/readers/get-observations.test.ts`
- Create: `packages/core/src/readers/get-observations.ts`

- [ ] **Step 1: Test**

```ts
// packages/core/test/readers/get-observations.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { getObservations } from '../../src/readers/get-observations.js';

describe('getObservations', () => {
  test('hydrates t2 rows by id with all known fields', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type, concepts, file_paths)
       VALUES ('m1', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 't', 'b', '{}', '2026-05-03', '2026-05-03', 'feature', '["acp"]', '["agentchat.yaml"]')`,
    );
    const out = getObservations(db, { ids: ['m1', 'missing'] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('m1');
    expect(out[0].obs_type).toBe('feature');
    expect(out[0].concepts).toEqual(['acp']);
    expect(out[0].file_paths).toEqual(['agentchat.yaml']);
  });

  test('respects requested order', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string) =>
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', '', '', '{}', '2026-05-03', '2026-05-03')`,
        [id],
      );
    insert('a'); insert('b'); insert('c');
    const out = getObservations(db, { ids: ['c', 'a', 'b'] });
    expect(out.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// packages/core/src/readers/get-observations.ts
import type { Database } from 'bun:sqlite';

export interface GetObservationsRequest {
  ids: string[];
}

export interface ObservationDetail {
  id: string;
  tier: 't2';
  ts: string;
  project_id: string | null;
  obs_type: string | null;
  severity: string | null;
  concepts: string[];
  file_paths: string[];
  title: string;
  body: string;
}

export function getObservations(db: Database, req: GetObservationsRequest): ObservationDetail[] {
  if (req.ids.length === 0) return [];
  const placeholders = req.ids.map(() => '?').join(',');
  const rows = db
    .query<{ memory_id: string; created_at: string; project_id: string | null; obs_type: string | null; severity: string | null; concepts: string | null; file_paths: string | null; title: string; body: string }, string[]>(
      `SELECT memory_id, created_at, project_id, obs_type, severity, concepts, file_paths, title, body
         FROM t2_memories WHERE memory_id IN (${placeholders})`,
    )
    .all(...req.ids);
  const byId = new Map(rows.map((r) => [r.memory_id, r] as const));
  const out: ObservationDetail[] = [];
  for (const id of req.ids) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      id: r.memory_id,
      tier: 't2',
      ts: r.created_at,
      project_id: r.project_id,
      obs_type: r.obs_type,
      severity: r.severity,
      concepts: JSON.parse(r.concepts ?? '[]'),
      file_paths: JSON.parse(r.file_paths ?? '[]'),
      title: r.title,
      body: r.body,
    });
  }
  return out;
}
```

- [ ] **Step 3: Verify + commit**

```bash
bun test packages/core/test/readers/get-observations.test.ts
git add packages/core/src/readers/get-observations.ts packages/core/test/readers/get-observations.test.ts
git commit -m "feat(memory): get-observations batch hydrator preserving requested order"
```

### Task 3.5: Daemon HTTP routes for the three readers

**Files:**
- Modify: `packages/daemon/src/routes/recall.ts` (or create `packages/daemon/src/routes/memory.ts`)
- Modify: `packages/daemon/src/serve.ts` (route table)

- [ ] **Step 1: Add three routes**

In `packages/daemon/src/routes/memory.ts` (new file; pattern after the existing `recall.ts`):

```ts
import type { Services } from '@penumbra/core';
import { SearchRequestSchema } from '@penumbra/core/schemas/recall';
import { search }            from '@penumbra/core/readers/search';
import { timeline }          from '@penumbra/core/readers/timeline';
import { getObservations }   from '@penumbra/core/readers/get-observations';

export async function memorySearchRoute(req: Request, services: Services): Response | Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const parsed = SearchRequestSchema.parse(body);
  const hits = search(services.db, parsed);
  return new Response(JSON.stringify({ hits }), { headers: { 'content-type': 'application/json' } });
}

export async function memoryTimelineRoute(req: Request, services: Services): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { anchor: string; depth_before?: number; depth_after?: number; project_id?: string | null };
  const out = timeline(services.db, {
    anchor: body.anchor,
    depth_before: body.depth_before ?? 3,
    depth_after:  body.depth_after  ?? 3,
    project_id:   body.project_id,
  });
  return new Response(JSON.stringify({ entries: out }), { headers: { 'content-type': 'application/json' } });
}

export async function memoryGetRoute(req: Request, services: Services): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { ids: string[] };
  const out = getObservations(services.db, { ids: body.ids ?? [] });
  return new Response(JSON.stringify({ observations: out }), { headers: { 'content-type': 'application/json' } });
}
```

- [ ] **Step 2: Register in `serve.ts`**

```ts
import { memorySearchRoute, memoryTimelineRoute, memoryGetRoute } from './routes/memory.js';
// ...
if (req.method === 'POST' && url.pathname === '/memory/search')   return memorySearchRoute(req, opts.services);
if (req.method === 'POST' && url.pathname === '/memory/timeline') return memoryTimelineRoute(req, opts.services);
if (req.method === 'POST' && url.pathname === '/memory/get')      return memoryGetRoute(req, opts.services);
```

- [ ] **Step 3: Add daemon-client wrappers in `packages/mcp/src/daemon-client.ts`**

```ts
async memorySearch(req: SearchRequest)        { return this.post('/memory/search', req).then((r) => r.hits as SearchHit[]); }
async memoryTimeline(req: TimelineRequest)    { return this.post('/memory/timeline', req).then((r) => r.entries as TimelineEntry[]); }
async memoryGet(req: GetObservationsRequest)  { return this.post('/memory/get', req).then((r) => r.observations as ObservationDetail[]); }
```

- [ ] **Step 4: Restart the daemon and curl-smoke each route**

```bash
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
curl -s -X POST http://127.0.0.1:51257/memory/search   -d '{"query":"acp","limit":3}' | jq .
curl -s -X POST http://127.0.0.1:51257/memory/timeline -d "{\"anchor\":\"$(curl -s -X POST http://127.0.0.1:51257/memory/search -d '{"query":"acp","limit":1}' | jq -r '.hits[0].id')\",\"depth_before\":2,\"depth_after\":2}" | jq .
```

Expected: search returns hits[]; timeline returns entries[].

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/memory.ts packages/daemon/src/serve.ts packages/mcp/src/daemon-client.ts
git commit -m "feat(daemon): /memory/{search,timeline,get} routes for 3-layer recall workflow"
```

### Task 3.6: Three new MCP tools

**Files:**
- Create: `packages/mcp/src/tools/search.ts`
- Create: `packages/mcp/src/tools/timeline.ts`
- Create: `packages/mcp/src/tools/get-observations.ts`
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Add the tool files**

```ts
// packages/mcp/src/tools/search.ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const SearchInputShape = {
  query:      z.string().min(1).describe('Free-text query (FTS5 syntax allowed)'),
  project_id: z.string().nullable().optional(),
  limit:      z.number().int().positive().max(100).optional(),
  obs_type:   z.string().optional().describe("Filter: decision|bugfix|feature|refactor|discovery|change|security_alert|security_note|session"),
  concept:    z.string().optional().describe('Substring match against the concepts array'),
  file_path:  z.string().optional().describe('Substring match against file_paths array'),
  dateStart:  z.string().optional(),
  dateEnd:    z.string().optional(),
  tiers:      z.array(z.enum(['t1', 't2'])).optional(),
  offset:     z.number().int().min(0).optional(),
};

export function searchHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const out = await daemon.memorySearch(input as never);
    return toTextContent(out);
  };
}
```

```ts
// packages/mcp/src/tools/timeline.ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const TimelineInputShape = {
  anchor:       z.string().min(1).describe('Observation ID to center the timeline around'),
  depth_before: z.number().int().min(0).max(50).optional(),
  depth_after:  z.number().int().min(0).max(50).optional(),
  project_id:   z.string().nullable().optional(),
};

export function timelineHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const out = await daemon.memoryTimeline(input as never);
    return toTextContent(out);
  };
}
```

```ts
// packages/mcp/src/tools/get-observations.ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const GetObservationsInputShape = {
  ids: z.array(z.string()).min(1).max(50).describe('IDs returned by memory.search or memory.timeline'),
};

export function getObservationsHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const out = await daemon.memoryGet(input as never);
    return toTextContent(out);
  };
}
```

- [ ] **Step 2: Register in `packages/mcp/src/server.ts`**

After the `memory.recall` registration block:

```ts
import { SearchInputShape,           searchHandler }         from './tools/search.js';
import { TimelineInputShape,         timelineHandler }       from './tools/timeline.js';
import { GetObservationsInputShape,  getObservationsHandler } from './tools/get-observations.js';

server.registerTool(
  'memory.search',
  { description: 'Step 1 of 3-layer recall: compact index of memory hits with IDs and short snippets. Cheap to scan; pair with memory.timeline + memory.get_observations.', inputSchema: SearchInputShape },
  searchHandler(opts.daemon) as unknown as Parameters<typeof server.registerTool>[2],
);
server.registerTool(
  'memory.timeline',
  { description: 'Step 2: chronological neighbors around an anchor observation. Use to see what was happening just before/after a hit.', inputSchema: TimelineInputShape },
  timelineHandler(opts.daemon) as unknown as Parameters<typeof server.registerTool>[2],
);
server.registerTool(
  'memory.get_observations',
  { description: 'Step 3: hydrate full bodies for IDs. Always batch — do not call once per ID.', inputSchema: GetObservationsInputShape },
  getObservationsHandler(opts.daemon) as unknown as Parameters<typeof server.registerTool>[2],
);
```

- [ ] **Step 3: Run the MCP test suite**

```bash
bun test packages/mcp/test
```

Expected: all pass.

- [ ] **Step 4: Restart the MCP server (re-spawned per chat session by Claude Code; no daemon action needed) and exercise all three from a chat or smoke harness**

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/search.ts packages/mcp/src/tools/timeline.ts packages/mcp/src/tools/get-observations.ts packages/mcp/src/server.ts
git commit -m "feat(mcp): memory.search / memory.timeline / memory.get_observations 3-layer tools"
```

---

## Phase 4 — Hybrid orchestrator (filter → vector rerank → SQL hydrate)

### File Structure

- Create: `packages/core/src/readers/hybrid.ts` (orchestrator + Strategy interface)
- Create: `packages/core/src/readers/filters/{date,project,type,concept,file}.ts` (filter contributors)
- Create: `packages/core/test/readers/hybrid.test.ts`
- Modify: `packages/core/src/readers/recall.ts` (delegate `RecallReader.recall` to the new orchestrator when `strategy_hint` is provided; keep RRF path as default)

### Task 4.1: Test — hybrid first filters by metadata then re-ranks semantically

**Files:**
- Create: `packages/core/test/readers/hybrid.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/readers/hybrid.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { hybridSearch } from '../../src/readers/hybrid.js';
import { fakeEmbedder } from '../../src/embedder/fake.js';

describe('hybridSearch', () => {
  test('metadata pre-filter narrows the candidate set before vector rerank', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, type: string, body: string, vec: number[]) => {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', ?, ?, '{}', '2026-05-03', '2026-05-03', ?)`,
        [id, body, body, type],
      );
      const rowid = db.query<{ rowid: number }, [string]>(`SELECT rowid FROM t2_memories WHERE memory_id=?`).get(id)!.rowid;
      db.run(`INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)`, [rowid, new Float32Array(vec)]);
    };
    insert('a', 'bugfix',  'apple pie', [1, 0, 0, 0]);
    insert('b', 'feature', 'apple cart', [0.9, 0, 0, 0]);
    insert('c', 'bugfix',  'banana split', [0, 1, 0, 0]);

    const out = await hybridSearch(db, fakeEmbedder(), { query: 'apple', obs_type: 'bugfix', limit: 5 });
    expect(out.map((h) => h.id)).toEqual(['a']); // 'b' excluded by obs_type filter; 'c' loses on cosine
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
bun test packages/core/test/readers/hybrid.test.ts
```

Expected: FAIL.

### Task 4.2: Implement — filter contributors + orchestrator

**Files:**
- Create: `packages/core/src/readers/filters/index.ts` (barrel)
- Create: `packages/core/src/readers/filters/date.ts`
- Create: `packages/core/src/readers/filters/project.ts`
- Create: `packages/core/src/readers/filters/type.ts`
- Create: `packages/core/src/readers/filters/concept.ts`
- Create: `packages/core/src/readers/filters/file.ts`
- Create: `packages/core/src/readers/hybrid.ts`

- [ ] **Step 1: Filter shape**

```ts
// packages/core/src/readers/filters/index.ts
export interface FilterContrib {
  sql: string;          // a single SQL fragment without leading AND
  params: unknown[];
}

export function combineFilters(contribs: FilterContrib[]): { whereSql: string; params: unknown[] } {
  if (contribs.length === 0) return { whereSql: '1=1', params: [] };
  return {
    whereSql: contribs.map((c) => `(${c.sql})`).join(' AND '),
    params: contribs.flatMap((c) => c.params),
  };
}

export { typeFilter }    from './type.js';
export { projectFilter } from './project.js';
export { dateFilter }    from './date.js';
export { conceptFilter } from './concept.js';
export { fileFilter }    from './file.js';
```

```ts
// packages/core/src/readers/filters/type.ts
import type { FilterContrib } from './index.js';
export function typeFilter(obsType: string | undefined, col = 'obs_type'): FilterContrib | null {
  return obsType ? { sql: `${col} = ?`, params: [obsType] } : null;
}
```

```ts
// packages/core/src/readers/filters/project.ts
import type { FilterContrib } from './index.js';
export function projectFilter(projectId: string | null | undefined, col = 'project_id'): FilterContrib | null {
  if (projectId === undefined) return null;
  return projectId === null ? { sql: `${col} IS NULL`, params: [] } : { sql: `${col} = ?`, params: [projectId] };
}
```

```ts
// packages/core/src/readers/filters/date.ts
import type { FilterContrib } from './index.js';
export function dateFilter(start: string | undefined, end: string | undefined, col = 'created_at'): FilterContrib | null {
  if (!start && !end) return null;
  if (start && !end) return { sql: `${col} >= ?`, params: [start] };
  if (!start && end) return { sql: `${col} <= ?`, params: [end] };
  return { sql: `${col} BETWEEN ? AND ?`, params: [start!, end!] };
}
```

```ts
// packages/core/src/readers/filters/concept.ts
import type { FilterContrib } from './index.js';
export function conceptFilter(concept: string | undefined, col = 'concepts'): FilterContrib | null {
  return concept ? { sql: `${col} LIKE '%' || ? || '%'`, params: [concept] } : null;
}
```

```ts
// packages/core/src/readers/filters/file.ts
import type { FilterContrib } from './index.js';
export function fileFilter(file: string | undefined, col = 'file_paths'): FilterContrib | null {
  return file ? { sql: `${col} LIKE '%' || ? || '%'`, params: [file] } : null;
}
```

- [ ] **Step 2: Orchestrator**

```ts
// packages/core/src/readers/hybrid.ts
import type { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import {
  combineFilters,
  conceptFilter,
  dateFilter,
  fileFilter,
  projectFilter,
  typeFilter,
} from './filters/index.js';

export interface HybridRequest {
  query: string;
  limit: number;
  project_id?: string | null;
  obs_type?: string;
  concept?: string;
  file_path?: string;
  dateStart?: string;
  dateEnd?: string;
  candidate_pool?: number; // how many SQL candidates feed the rerank; default 4×limit
}

export interface HybridHit {
  id: string;
  ts: string;
  obs_type: string | null;
  title: string;
  body: string;
  score: number;
}

export async function hybridSearch(db: Database, embedder: Embedder, req: HybridRequest): Promise<HybridHit[]> {
  const pool = req.candidate_pool ?? Math.max(50, req.limit * 4);
  const filters = [
    projectFilter(req.project_id, 'm.project_id'),
    typeFilter(req.obs_type, 'm.obs_type'),
    conceptFilter(req.concept, 'm.concepts'),
    fileFilter(req.file_path, 'm.file_paths'),
    dateFilter(req.dateStart, req.dateEnd, 'm.created_at'),
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const { whereSql, params } = combineFilters(filters);

  // Stage 1: SQL pre-filter on metadata.
  const candidates = db
    .query<{ memory_id: string; rowid: number; created_at: string; obs_type: string | null; title: string; body: string }, unknown[]>(
      `SELECT m.memory_id, m.rowid, m.created_at, m.obs_type, m.title, m.body
         FROM t2_memories m
        WHERE ${whereSql}
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(...params, pool);
  if (candidates.length === 0) return [];

  // Stage 2: vector rerank against just those rowids.
  const [qvec] = await embedder.embed([req.query]);
  const qBlob = new Float32Array(qvec);
  const placeholders = candidates.map(() => '?').join(',');
  const ranked = db
    .query<{ rowid: number; distance: number }, unknown[]>(
      `SELECT v.rowid, v.distance
         FROM t2_vec v
        WHERE v.rowid IN (${placeholders})
          AND embedding MATCH ?
        ORDER BY distance ASC
        LIMIT ?`,
    )
    .all(...candidates.map((c) => c.rowid), qBlob, req.limit);

  const byRowid = new Map(candidates.map((c) => [c.rowid, c] as const));
  return ranked
    .map((r) => {
      const c = byRowid.get(r.rowid);
      if (!c) return null;
      return {
        id: c.memory_id,
        ts: c.created_at,
        obs_type: c.obs_type,
        title: c.title,
        body: c.body,
        score: 1 - r.distance, // distance → similarity for caller convenience
      };
    })
    .filter((x): x is HybridHit => x !== null);
}
```

- [ ] **Step 3: Verify**

```bash
bun test packages/core/test/readers/hybrid.test.ts
```

Expected: PASS.

- [ ] **Step 4: Plumb a `strategy_hint: 'hybrid'` option through `RecallReader` and `RecallRequestSchema`**

In `packages/core/src/schemas/recall.ts`:

```ts
strategy_hint: z.enum(['fts', 'vector', 'hybrid', 'rrf']).optional().describe('Default = rrf (current behavior). hybrid = SQL filter then vector rerank.'),
```

In `packages/core/src/readers/recall.ts`, near the top of `recall()`:

```ts
if (req.strategy_hint === 'hybrid') {
  const hits = await hybridSearch(this.db, this.embedder, {
    query: req.query,
    limit: req.limit,
    project_id: req.project_id ?? undefined,
    obs_type: req.obs_type,
    concept: req.concept,
    file_path: req.file_path,
    dateStart: req.dateStart,
    dateEnd: req.dateEnd,
  });
  return hits.map((h) => ({
    source: 't2',
    memory_id: h.id,
    title: h.title,
    body: h.body,
    score: h.score,
    ts: h.ts,
  }));
}
```

(Adapt the return shape to match your existing `RecallResult` — read it from `schemas/recall.ts` and match exactly.)

- [ ] **Step 5: Verify the existing recall suite still passes**

```bash
bun test packages/core/test packages/daemon/test/recall.test.ts packages/mcp/test/recall.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/readers/hybrid.ts packages/core/src/readers/filters packages/core/src/readers/recall.ts packages/core/src/schemas/recall.ts packages/core/test/readers/hybrid.test.ts
git commit -m "feat(memory): hybrid recall — SQL metadata filter then vector rerank with strategy_hint=hybrid"
```

---

## Phase 5 — Knowledge corpora (filtered observation bundles as topical RAG)

### File Structure

- Modify: `packages/core/src/db/schema.ts` (`corpora` and `corpus_members` tables)
- Create: `packages/core/src/readers/corpus.ts` (`buildCorpus`, `queryCorpus`, `listCorpora`, `removeCorpus`)
- Create: `packages/core/test/readers/corpus.test.ts`
- Create: `packages/mcp/src/tools/corpus-build.ts`
- Create: `packages/mcp/src/tools/corpus-query.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/agentchat/src/worker/recall-enricher.ts` (accept `scope: corpus:<id>`)
- Modify: `packages/agentchat/src/worker/recall-enricher.test.ts` (case for corpus scope)

### Task 5.1: Schema — corpora + corpus_members

- [ ] **Step 1: Add tables**

In `packages/core/src/db/schema.ts`:

```ts
    db.exec(`
      CREATE TABLE IF NOT EXISTS corpora (
        corpus_id   TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT,
        filter_json TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        member_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS corpus_members (
        corpus_id  TEXT NOT NULL,
        memory_id  TEXT NOT NULL,
        added_at   TEXT NOT NULL,
        PRIMARY KEY (corpus_id, memory_id),
        FOREIGN KEY (corpus_id) REFERENCES corpora(corpus_id)         ON DELETE CASCADE,
        FOREIGN KEY (memory_id) REFERENCES t2_memories(memory_id)     ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_corpus_members_memory ON corpus_members(memory_id);
    `);
```

### Task 5.2: Test — `buildCorpus` materialises a filtered subset

**Files:**
- Create: `packages/core/test/readers/corpus.test.ts`

- [ ] **Step 1: Test**

```ts
// packages/core/test/readers/corpus.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { buildCorpus, queryCorpus, listCorpora } from '../../src/readers/corpus.js';
import { fakeEmbedder } from '../../src/embedder/fake.js';

describe('corpus', () => {
  test('buildCorpus selects t2 rows by filter and persists membership', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, type: string) =>
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type, concepts)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 't', 'b', '{}', '2026-05-03', '2026-05-03', ?, '["acp"]')`,
        [id, type],
      );
    insert('m1', 'feature');
    insert('m2', 'bugfix');
    insert('m3', 'feature');

    const result = await buildCorpus(db, fakeEmbedder(), {
      name: 'acp-features',
      description: 'Feature work on ACP',
      filter: { obs_type: 'feature', concept: 'acp' },
    });
    expect(result.member_count).toBe(2);
    const list = listCorpora(db);
    expect(list.find((c) => c.name === 'acp-features')?.member_count).toBe(2);
  });

  test('queryCorpus restricts hybrid search to corpus members only', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const insert = (id: string, type: string, body: string, vec: number[]) => {
      db.run(
        `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type)
         VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', ?, ?, '{}', '2026-05-03', '2026-05-03', ?)`,
        [id, body, body, type],
      );
      const rowid = db.query<{ rowid: number }, [string]>(`SELECT rowid FROM t2_memories WHERE memory_id=?`).get(id)!.rowid;
      db.run(`INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)`, [rowid, new Float32Array(vec)]);
    };
    insert('m1', 'feature', 'codex acp wiring', [1, 0, 0, 0]);
    insert('m2', 'bugfix',  'codex acp crash', [0.9, 0, 0, 0]);
    await buildCorpus(db, fakeEmbedder(), { name: 'features-only', filter: { obs_type: 'feature' } });
    const out = await queryCorpus(db, fakeEmbedder(), { name: 'features-only', query: 'codex', limit: 5 });
    expect(out.map((h) => h.id)).toEqual(['m1']);
  });
});
```

### Task 5.3: Implement — `corpus.ts`

**Files:**
- Create: `packages/core/src/readers/corpus.ts`

- [ ] **Step 1: Implementation**

```ts
// packages/core/src/readers/corpus.ts
import type { Database } from 'bun:sqlite';
import type { Embedder } from '../embedder/interface.js';
import { hybridSearch, type HybridHit } from './hybrid.js';
import { combineFilters, typeFilter, conceptFilter, fileFilter, dateFilter, projectFilter } from './filters/index.js';
import { randomUUID } from 'node:crypto';

export interface CorpusFilter {
  project_id?: string | null;
  obs_type?: string;
  concept?: string;
  file_path?: string;
  dateStart?: string;
  dateEnd?: string;
  query?: string;          // optional FTS pre-filter
  limit?: number;          // cap members; default 500
}

export interface BuildCorpusInput {
  name: string;
  description?: string;
  filter: CorpusFilter;
}

export interface CorpusSummary {
  corpus_id: string;
  name: string;
  description: string | null;
  member_count: number;
  created_at: string;
}

export async function buildCorpus(db: Database, _embedder: Embedder, input: BuildCorpusInput): Promise<CorpusSummary> {
  const filterContribs = [
    projectFilter(input.filter.project_id, 'm.project_id'),
    typeFilter(input.filter.obs_type, 'm.obs_type'),
    conceptFilter(input.filter.concept, 'm.concepts'),
    fileFilter(input.filter.file_path, 'm.file_paths'),
    dateFilter(input.filter.dateStart, input.filter.dateEnd, 'm.created_at'),
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const { whereSql, params } = combineFilters(filterContribs);
  const cap = input.filter.limit ?? 500;

  const rows = db
    .query<{ memory_id: string }, unknown[]>(
      `SELECT m.memory_id FROM t2_memories m WHERE ${whereSql} ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(...params, cap);

  const corpus_id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO corpora(corpus_id, name, description, filter_json, created_at, updated_at, member_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET filter_json=excluded.filter_json, updated_at=excluded.updated_at, member_count=excluded.member_count`,
    [corpus_id, input.name, input.description ?? null, JSON.stringify(input.filter), now, now, rows.length],
  );
  // Resolve corpus_id (in case ON CONFLICT used a pre-existing row)
  const existing = db.query<{ corpus_id: string }, [string]>(`SELECT corpus_id FROM corpora WHERE name=?`).get(input.name)!;
  db.run(`DELETE FROM corpus_members WHERE corpus_id=?`, [existing.corpus_id]);
  const insertMember = db.prepare(`INSERT INTO corpus_members(corpus_id, memory_id, added_at) VALUES (?, ?, ?)`);
  for (const r of rows) insertMember.run(existing.corpus_id, r.memory_id, now);

  return { corpus_id: existing.corpus_id, name: input.name, description: input.description ?? null, member_count: rows.length, created_at: now };
}

export function listCorpora(db: Database): CorpusSummary[] {
  return db
    .query<{ corpus_id: string; name: string; description: string | null; member_count: number; created_at: string }, []>(
      `SELECT corpus_id, name, description, member_count, created_at FROM corpora ORDER BY created_at DESC`,
    )
    .all();
}

export function removeCorpus(db: Database, name: string): boolean {
  const before = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM corpora`).get()?.c ?? 0;
  db.run(`DELETE FROM corpora WHERE name=?`, [name]);
  const after = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM corpora`).get()?.c ?? 0;
  return after < before;
}

export async function queryCorpus(
  db: Database,
  embedder: Embedder,
  req: { name: string; query: string; limit?: number },
): Promise<HybridHit[]> {
  const limit = req.limit ?? 10;
  const corpus = db.query<{ corpus_id: string }, [string]>(`SELECT corpus_id FROM corpora WHERE name=?`).get(req.name);
  if (!corpus) return [];
  const memberRows = db
    .query<{ memory_id: string }, [string]>(`SELECT memory_id FROM corpus_members WHERE corpus_id=?`)
    .all(corpus.corpus_id);
  if (memberRows.length === 0) return [];

  // Fetch candidate rows + their rowids; constrain vec rerank to those rowids.
  const placeholders = memberRows.map(() => '?').join(',');
  const candidates = db
    .query<{ memory_id: string; rowid: number; created_at: string; obs_type: string | null; title: string; body: string }, string[]>(
      `SELECT memory_id, rowid, created_at, obs_type, title, body FROM t2_memories WHERE memory_id IN (${placeholders})`,
    )
    .all(...memberRows.map((m) => m.memory_id));
  if (candidates.length === 0) return [];

  const [qvec] = await embedder.embed([req.query]);
  const ranked = db
    .query<{ rowid: number; distance: number }, unknown[]>(
      `SELECT v.rowid, v.distance FROM t2_vec v
        WHERE v.rowid IN (${candidates.map(() => '?').join(',')})
          AND embedding MATCH ?
        ORDER BY distance ASC LIMIT ?`,
    )
    .all(...candidates.map((c) => c.rowid), new Float32Array(qvec), limit);
  const byRowid = new Map(candidates.map((c) => [c.rowid, c] as const));
  return ranked
    .map((r) => {
      const c = byRowid.get(r.rowid);
      if (!c) return null;
      return { id: c.memory_id, ts: c.created_at, obs_type: c.obs_type, title: c.title, body: c.body, score: 1 - r.distance };
    })
    .filter((x): x is HybridHit => x !== null);
}
```

- [ ] **Step 2: Verify**

```bash
bun test packages/core/test/readers/corpus.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/readers/corpus.ts packages/core/test/readers/corpus.test.ts
git commit -m "feat(memory): knowledge corpora — buildCorpus, queryCorpus, listCorpora"
```

### Task 5.4: MCP tools for corpora

**Files:**
- Create: `packages/mcp/src/tools/corpus-build.ts`
- Create: `packages/mcp/src/tools/corpus-query.ts`
- Create: `packages/mcp/src/tools/corpus-list.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Modify: `packages/daemon/src/routes/memory.ts` (`/memory/corpus/{build,query,list}`)

- [ ] **Step 1: Tools**

```ts
// packages/mcp/src/tools/corpus-build.ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const CorpusBuildInputShape = {
  name:        z.string().min(1).max(64),
  description: z.string().max(280).optional(),
  filter: z.object({
    project_id: z.string().nullable().optional(),
    obs_type:   z.string().optional(),
    concept:    z.string().optional(),
    file_path:  z.string().optional(),
    dateStart:  z.string().optional(),
    dateEnd:    z.string().optional(),
    query:      z.string().optional(),
    limit:      z.number().int().positive().max(2000).optional(),
  }),
};

export function corpusBuildHandler(daemon: DaemonClient) {
  return async (input: unknown) => toTextContent(await daemon.corpusBuild(input as never));
}
```

```ts
// packages/mcp/src/tools/corpus-query.ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const CorpusQueryInputShape = {
  name:  z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
};

export function corpusQueryHandler(daemon: DaemonClient) {
  return async (input: unknown) => toTextContent(await daemon.corpusQuery(input as never));
}
```

```ts
// packages/mcp/src/tools/corpus-list.ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const CorpusListInputShape = {} as const;

export function corpusListHandler(daemon: DaemonClient) {
  return async () => toTextContent(await daemon.corpusList());
}
```

- [ ] **Step 2: Daemon routes + client wrappers + server.ts registration** — same shape as Phase 3 (`/memory/corpus/build`, `/memory/corpus/query`, `/memory/corpus/list`).

- [ ] **Step 3: Smoke**

```bash
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
curl -s -X POST http://127.0.0.1:51257/memory/corpus/build \
  -d '{"name":"acp-features","filter":{"obs_type":"feature","concept":"acp"}}' | jq .
curl -s -X POST http://127.0.0.1:51257/memory/corpus/list | jq .
curl -s -X POST http://127.0.0.1:51257/memory/corpus/query \
  -d '{"name":"acp-features","query":"codex","limit":3}' | jq .
```

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/tools/corpus-* packages/mcp/src/server.ts packages/mcp/src/daemon-client.ts packages/daemon/src/routes/memory.ts
git commit -m "feat(mcp): memory.corpus_build / corpus_query / corpus_list tools"
```

### Task 5.5: Wire `recall_context.scope: corpus:<name>` into the worker enricher

**Files:**
- Modify: `packages/agentchat/src/worker/recall-enricher.ts`
- Modify: `packages/agentchat/test/worker/recall-enricher.test.ts`

- [ ] **Step 1: Test — agent with `recall_context.scope: 'corpus:acp-features'` gets corpus-scoped hits**

Read the existing `recall-enricher.test.ts` for setup conventions and add a case:

```ts
test('scope: corpus:<name> queries the corpus instead of project/global recall', async () => {
  // Build a corpus with a single member, then run the enricher
  // with recall_context.scope = 'corpus:tiny'.
  // Expect the enricher to call daemon.corpusQuery and inject that result
  // verbatim into the per-agent prompt.
});
```

(Fill in the exact construction from neighbouring tests — I'm leaving the harness setup elided here because it's repository-specific; copy from the file's existing tests.)

- [ ] **Step 2: Implement — branch on `scope` prefix**

In `recall-enricher.ts`, where the existing scope dispatch is (`'project' | 'global'`), add:

```ts
if (scope.startsWith('corpus:')) {
  const name = scope.slice('corpus:'.length);
  const hits = await daemon.corpusQuery({ name, query: agentPrompt, limit: k });
  return formatCorpusHits(hits, maxCharsPerResult);
}
```

- [ ] **Step 3: Smoke — set one agent in `~/.config/agentchat/agentchat.yaml` to `recall_context.scope: corpus:acp-features` (after building that corpus), reload daemon, dispatch, and check that the agent's prompt contains corpus-sourced lines**

- [ ] **Step 4: Commit**

```bash
git add packages/agentchat/src/worker/recall-enricher.ts packages/agentchat/test/worker/recall-enricher.test.ts
git commit -m "feat(agentchat): recall_context scope=corpus:<name> primes worker with corpus hits"
```

---

## Phase 6 — Recall-status MCP tool

### File Structure

- Create: `packages/core/src/readers/recall-status.ts`
- Create: `packages/core/test/readers/recall-status.test.ts`
- Create: `packages/mcp/src/tools/recall-status.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Modify: `packages/daemon/src/routes/memory.ts` (`/memory/status`)

### Task 6.1: Test + implement — `recall-status`

**Files:**
- Create: `packages/core/test/readers/recall-status.test.ts`
- Create: `packages/core/src/readers/recall-status.ts`

- [ ] **Step 1: Test**

```ts
// packages/core/test/readers/recall-status.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { recallStatus } from '../../src/readers/recall-status.js';

describe('recallStatus', () => {
  test('reports tier counts, t2 type/severity histograms, t1 promotion backlog, and corpus count', () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    db.run(
      `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type, severity)
       VALUES ('m1', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 't', 'b', '{}', '2026-05-03', '2026-05-03', 'feature', 'info'),
              ('m2', 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 't', 'b', '{}', '2026-05-03', '2026-05-03', 'bugfix', 'error')`,
    );
    db.run(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, source_event_ids, t2_promoted_at, failed_promotion_attempts)
       VALUES ('r1', 'u', 's1', '2026-05-03', '2026-05-03', 1, '[]', NULL, 0),
              ('r2', 'u', 's2', '2026-05-03', '2026-05-03', 1, '[]', '2026-05-03', 0),
              ('r3', 'u', 's3', '2026-05-03', '2026-05-03', 1, '[]', NULL, 4)`,
    );

    const status = recallStatus(db);
    expect(status.tiers.t2).toBe(2);
    expect(status.tiers.t1).toBe(3);
    expect(status.t2_by_obs_type).toEqual({ feature: 1, bugfix: 1 });
    expect(status.t2_by_severity).toEqual({ info: 1, error: 1 });
    expect(status.t1_unpromoted).toBe(2);
    expect(status.t1_failed).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// packages/core/src/readers/recall-status.ts
import type { Database } from 'bun:sqlite';

export interface RecallStatus {
  tiers: { t0: number; t1: number; t2: number };
  t2_by_obs_type:  Record<string, number>;
  t2_by_severity:  Record<string, number>;
  t1_unpromoted:   number;
  t1_failed:       number; // failed_promotion_attempts > 0
  corpora:         number;
  last_recall_ts?: string;
}

export function recallStatus(db: Database): RecallStatus {
  const tiers = {
    t0: db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t0_events`).get()?.c ?? 0,
    t1: db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t1_rollups`).get()?.c ?? 0,
    t2: db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories`).get()?.c ?? 0,
  };

  const histo = (rows: Array<{ k: string | null; c: number }>) =>
    Object.fromEntries(rows.filter((r) => r.k !== null).map((r) => [r.k as string, r.c]));

  const t2ByType = histo(
    db.query<{ k: string | null; c: number }, []>(`SELECT obs_type AS k, COUNT(*) AS c FROM t2_memories GROUP BY obs_type`).all(),
  );
  const t2BySev = histo(
    db.query<{ k: string | null; c: number }, []>(`SELECT severity AS k, COUNT(*) AS c FROM t2_memories GROUP BY severity`).all(),
  );

  const t1Unpromoted = db
    .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t1_rollups WHERE t2_promoted_at IS NULL`)
    .get()?.c ?? 0;
  const t1Failed = db
    .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t1_rollups WHERE failed_promotion_attempts > 0`)
    .get()?.c ?? 0;
  const corpora = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM corpora`).get()?.c ?? 0;
  const lastRecall = db
    .query<{ ts: string | null }, []>(`SELECT MAX(ts) AS ts FROM recall_audit`)
    .get()?.ts ?? undefined;

  return {
    tiers,
    t2_by_obs_type: t2ByType,
    t2_by_severity: t2BySev,
    t1_unpromoted: t1Unpromoted,
    t1_failed: t1Failed,
    corpora,
    ...(lastRecall ? { last_recall_ts: lastRecall } : {}),
  };
}
```

- [ ] **Step 3: Verify**

```bash
bun test packages/core/test/readers/recall-status.test.ts
```

### Task 6.2: Daemon route + MCP tool

**Files:**
- Modify: `packages/daemon/src/routes/memory.ts` (`/memory/status`)
- Create: `packages/mcp/src/tools/recall-status.ts`
- Modify: `packages/mcp/src/server.ts`, `packages/mcp/src/daemon-client.ts`

- [ ] **Step 1: HTTP route**

```ts
export async function memoryStatusRoute(_req: Request, services: Services): Promise<Response> {
  const out = recallStatus(services.db);
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}
```

Register `GET /memory/status` in `serve.ts`.

- [ ] **Step 2: MCP tool**

```ts
// packages/mcp/src/tools/recall-status.ts
import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const RecallStatusInputShape = {} as const;

export function recallStatusHandler(daemon: DaemonClient) {
  return async () => toTextContent(await daemon.recallStatus());
}
```

Register as `'memory.status'` in `server.ts`.

- [ ] **Step 3: Smoke**

```bash
launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon
curl -s http://127.0.0.1:51257/memory/status | jq .
```

Expected: tiers + histograms + corpora count.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/readers/recall-status.ts packages/core/test/readers/recall-status.test.ts packages/daemon/src/routes/memory.ts packages/daemon/src/serve.ts packages/mcp/src/tools/recall-status.ts packages/mcp/src/server.ts packages/mcp/src/daemon-client.ts
git commit -m "feat(memory): memory.status MCP tool — tier counts, type/severity histograms, t1 backlog"
```

---

## Phase 7 — Documentation + AGENTS.md updates

- [ ] **Step 1: Update AGENTS.md**

In the "MCP surface" section, add the four new memory tools (`memory.search`, `memory.timeline`, `memory.get_observations`, `memory.corpus_*`, `memory.status`) and the `--file` flag on `penumbra recall`.

- [ ] **Step 2: Add a recipe to `docs/notes/recall-cookbook.md` (new file)**

```markdown
# Recall Cookbook

## 3-layer search workflow (token-efficient)

1. `memory.search({ query, obs_type?, file_path? })` — get the index
2. `memory.timeline({ anchor, depth_before, depth_after })` — get neighbours
3. `memory.get_observations({ ids })` — hydrate the 2–3 you actually need

Avoid `memory.recall` when you only need the title list.

## Knowledge corpora

To prime a worker with only ACP work:

1. `memory.corpus_build({ name: 'acp-work', filter: { concept: 'acp' } })`
2. In `~/.config/agentchat/agentchat.yaml`, set:
   ```yaml
   recall_context:
     enabled: true
     scope: corpus:acp-work
     k: 5
   ```
3. Reload daemon.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/notes/recall-cookbook.md
git commit -m "docs: recall cookbook + AGENTS.md tool surface for new memory.* tools"
```

---

## Self-review

**Spec coverage check:**

| Original gap | Plan tasks |
|---|---|
| Multi-field FTS with distinct columns | Phase 1 (t1_fts/t2_fts virtual tables) |
| Hybrid search strategy (filter → rerank) | Phase 4 |
| Filter classes (Date / Project / Type / Concept / File) | Phase 4 (filters/) |
| First-class typed observations (obs_type) | Phase 1 (column + backfill + writer) |
| First-class concepts | Phase 1 (column + backfill + FTS) |
| By-file recall | Phase 2 (t0_file_refs trigger + recall scoping) |
| Diagnostics with severity | Phase 1 (severity column + backfill); Phase 6 (status surface) |
| 3-layer search workflow MCP tools | Phase 3 |
| Knowledge corpora | Phase 5 |
| Prompts as queryable | Phase 1 (t1_fts indexes prompt + response excerpts) |
| Recall-audit / processing-status visibility | Phase 6 |

All gaps from the analysis are mapped to a task. ✓

**Type-consistency check:** `SearchHit`, `TimelineEntry`, `ObservationDetail`, `HybridHit`, `CorpusFilter`, `RecallStatus` — names are stable across phases. The `obs_type` enum is defined once in Phase 1 (`ObsTypeEnum` in `packages/core/src/schemas/memory.ts`) and reused in tool input shapes. The filter contributors (`typeFilter`, `conceptFilter`, …) all share the `FilterContrib` shape introduced in Phase 4.

**Placeholder scan:** no `TBD`, no "Add appropriate error handling", no orphan `Similar to Task N`. The one TODO-ish phrase ("Fill in the exact construction from neighbouring tests …" in Task 5.5) is intentional — that test harness is heavy and the executor should mirror the existing pattern verbatim. If you'd rather it be self-contained, refactor that step before handing off.

---

## Phase ordering and dependencies

```
Phase 1 (schema + writer + backfill) ──┬──> Phase 2 (file refs)
                                       ├──> Phase 3 (3-layer tools)
                                       └──> Phase 4 (hybrid orchestrator)
                                                  ├──> Phase 5 (corpora; depends on hybrid)
                                                  └──> Phase 6 (status; only depends on Phase 1)

Phase 7 (docs) at the end.
```

Phase 1 is the unlock. Phases 2/3/4 are independent of each other after Phase 1 lands. Phase 5 depends on Phase 4. Phase 6 depends on Phase 1 + Phase 5. Phases 1, 2, 3, 6 are each shippable end-to-end without the others; Phase 4 + Phase 5 are an inseparable pair.

Total estimated effort, sequential:

| Phase | Effort |
|---|---|
| 1 | ~1 day |
| 2 | ½ day |
| 3 | ½ day |
| 4 | 1 day |
| 5 | 1 day |
| 6 | ½ day |
| 7 | ½ day |
| **Total** | **~5 days** |
