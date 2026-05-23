---
title: Penumbra Memory CC-Class UX Integration Plan
version: "0.1"
date: 2026-05-23
status: approved
---

# Penumbra Memory — CC-Class UX Integration Plan

## Context

Claude Code file-memory at ~/.claude/projects/.../memory/ is invisible to penumbra's dreaming pipeline, not searchable via MCP, and not linked to any project context. This plan migrates to penumbra-native storage while preserving the UX via SessionStart hook.

## Approved v0.1 Design

- Write path: MCP tool memory_write_t2, writes to t2_memories with origin=direct
- Schema additions: slug TEXT (stable kebab-case ID), hook TEXT (one-line digest summary), sub_kind TEXT, cc_kind TEXT (CC taxonomy: user|feedback|project|reference)
- kind field: set to sentinel 'direct' for origin=direct entries
- [[backlinks]]: parsed and inserted into memory_links as wiki/wiki_unresolved
- Digest: penumbra memory digest --maestro -> MEMORY.md-analog output
- Import CLI: penumbra memory import-from-claude-code --root <path>
- Cutover: archive memory/ after import verified on 70 entries

## Re-Opens

### A. Dual kind Taxonomy
The kind column holds dreaming-pipeline values (knowledge, decision, fact, etc.). Adding cc_kind as a separate column is safer than repurposing kind. Set kind='direct' as sentinel for origin=direct entries.

### B. Curator May Retire Direct Entries
Curator retire sweep must add WHERE (origin IS NULL OR origin != 'direct'). Implementer must audit all UPDATE t2_memories SET retired_at calls in packages/core/src/curator/.

### C. window_start / window_end for Direct Writes
Set both to new Date().toISOString() at write time for direct entries.

## Phase 1 — Schema Migration

Goal: Add slug, hook, sub_kind, cc_kind, origin columns to t2_memories; add partial UNIQUE index on slug.

Files: packages/core/src/db/schema.ts (addColumnIfMissing cluster for t2_memories ~lines 591-636), packages/core/src/schemas/memory.ts

In schema.ts, add to the t2_memories addColumnIfMissing block:

```typescript
addColumnIfMissing(db, 't2_memories', 'slug', 'TEXT');
addColumnIfMissing(db, 't2_memories', 'hook', 'TEXT');
addColumnIfMissing(db, 't2_memories', 'sub_kind', 'TEXT');
addColumnIfMissing(db, 't2_memories', 'cc_kind', 'TEXT');
addColumnIfMissing(db, 't2_memories', 'origin', 'TEXT');
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_t2_slug ON t2_memories(slug) WHERE slug IS NOT NULL`);
```

Failing test (write before implementing):

```typescript
// packages/core/src/db/__tests__/schema-t2-slug.test.ts
describe('t2_memories slug index', () => {
  test('allows multiple null slugs', () => {
    const db = buildTestDb();
    db.run(`INSERT INTO t2_memories (memory_id, title, body, window_start, window_end) VALUES ('a1', 'A', 'body', '2026-01-01', '2026-01-01')`);
    db.run(`INSERT INTO t2_memories (memory_id, title, body, window_start, window_end) VALUES ('a2', 'B', 'body', '2026-01-01', '2026-01-01')`);
    const rows = db.query('SELECT memory_id FROM t2_memories WHERE slug IS NULL').all();
    expect(rows.length).toBe(2);
  });

  test('rejects duplicate non-null slugs', () => {
    const db = buildTestDb();
    db.run(`INSERT INTO t2_memories (memory_id, slug, title, body, window_start, window_end) VALUES ('b1', 'my-slug', 'A', 'body', '2026-01-01', '2026-01-01')`);
    expect(() =>
      db.run(`INSERT INTO t2_memories (memory_id, slug, title, body, window_start, window_end) VALUES ('b2', 'my-slug', 'B', 'body', '2026-01-01', '2026-01-01')`)
    ).toThrow(/UNIQUE constraint/);
  });

  test('upsert on slug updates body', () => {
    const db = buildTestDb();
    db.run(`INSERT INTO t2_memories (memory_id, slug, title, body, window_start, window_end) VALUES ('c1', 'upsert-me', 'T', 'old', '2026-01-01', '2026-01-01')`);
    db.run(`INSERT OR REPLACE INTO t2_memories (memory_id, slug, title, body, window_start, window_end) VALUES ('c1', 'upsert-me', 'T', 'new', '2026-01-01', '2026-01-01')`);
    const row = db.query(`SELECT body FROM t2_memories WHERE slug = 'upsert-me'`).get() as any;
    expect(row.body).toBe('new');
  });
});
```

Reversibility: Fully reversible. addColumnIfMissing is additive. No data loss.
Demoable: No.

## Phase 2 — Direct-Write Service + HTTP Route + MCP Tool

Goal: POST /memory/write from the daemon and memory_write_t2 MCP tool. Embedder runs server-side.

Files:
- packages/core/src/writers/t2.ts — add writeDirectT2Memory
- packages/daemon/src/routes/memory.ts — add memoryWriteT2Route
- packages/daemon/src/serve.ts — add URL dispatch for POST /memory/write
- packages/mcp/src/daemon-client.ts — add memoryWriteT2() method
- packages/mcp/src/tools/registry.ts — add memory_write_t2 entry

Writer signature:

```typescript
export interface DirectT2WriteInput {
  slug?: string | null;
  hook?: string | null;
  sub_kind?: string | null;
  cc_kind?: string | null;
  title: string;
  body: string;
  project_id?: string | null;
  embedding: Float32Array;
}

export function writeDirectT2Memory(db: Database, input: DirectT2WriteInput): string
```

Route: POST /memory/write accepts JSON {title, body, slug?, hook?, sub_kind?, cc_kind?, project_id?}, embeds body server-side, calls writeDirectT2Memory, parses [[slug]] backlinks into memory_links. Returns {memory_id}.

MCP tool: memory_write_t2 with inputSchema matching above. readOnly: false.

Failing tests:

```typescript
// packages/daemon/src/__tests__/routes/memory-write.test.ts
test('writes a direct memory with slug', async () => {
  const res = await fetch('/memory/write', { method: 'POST', body: JSON.stringify({ title: 'T', body: 'B', slug: 'test-slug', hook: 'h', cc_kind: 'user' }) });
  expect(res.status).toBe(200);
  const row = db.query(`SELECT origin, slug, cc_kind FROM t2_memories WHERE slug = 'test-slug'`).get();
  expect(row.origin).toBe('direct');
});

test('upserts on slug', async () => {
  await POST('/memory/write', { title: 'T', body: 'old', slug: 'up-slug' });
  await POST('/memory/write', { title: 'T', body: 'new', slug: 'up-slug' });
  const row = db.query(`SELECT body FROM t2_memories WHERE slug = 'up-slug'`).get();
  expect(row.body).toBe('new');
});

test('curator guard does not retire direct entries', async () => {
  db.run(`INSERT INTO t2_memories (memory_id, origin, ...) VALUES ('guard-1', 'direct', ...)`);
  db.run(`UPDATE t2_memories SET retired_at = datetime('now') WHERE retired_at IS NULL AND (origin IS NULL OR origin != 'direct')`);
  const row = db.query(`SELECT retired_at FROM t2_memories WHERE memory_id = 'guard-1'`).get();
  expect(row.retired_at).toBeNull();
});
```

Reversibility: Route and tool can be removed. Direct entries bulk-deletable. Safe.
Demoable: Yes — memory_write_t2 callable from Claude Code MCP immediately.

## Phase 3 — penumbra memory digest CLI

Goal: penumbra memory digest [--maestro] outputs MEMORY.md-style index of origin=direct entries.

Query:
```sql
SELECT slug, title, hook FROM t2_memories
WHERE origin = 'direct' AND retired_at IS NULL AND slug IS NOT NULL AND hook IS NOT NULL
  AND (project_id IS NULL)  -- with --maestro
ORDER BY updated_at DESC LIMIT 200
```

Output per row: - [title](slug) — hook

Files: packages/cli/src/commands/memory.ts (new), packages/cli/bin/penumbra.ts

Failing tests:
- lists direct entries with slug and hook
- excludes retired entries
- excludes non-direct (origin IS NULL) entries

Reversibility: CLI command only, no DB changes.
Demoable: Yes, once Phase 2 has written entries.

## Phase 4 — Import Dry-Run

Goal: penumbra memory import-from-claude-code --root <path> --dry-run parses CC frontmatter and prints what would be written.

Frontmatter mapping: name->title, name->slug (slugify), description->hook, type->cc_kind, body->body, project_id=null (global).

Slugify: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

Failing tests: parses CC frontmatter correctly, skips files without frontmatter.
Reversibility: No DB writes. Always safe.
Demoable: No (informational only).

## Phase 5 — Import Full Run (First Demoable Win)

Goal: penumbra memory import-from-claude-code --root <path> writes all entries to t2_memories. After this phase penumbra memory digest --maestro lists ~70 entries.

Implementation:
- Pass 1: POST each entry to /memory/write (idempotent via slug UPSERT)
- Pass 2: resolve wiki_unresolved backlinks after all entries written

Failing tests:
- writes entries to t2_memories
- is idempotent (second run does not duplicate)
- digest shows imported entries

Reversibility: DELETE FROM t2_memories WHERE origin = 'direct' restores original state.
Demoable: YES — first demoable win. Run import then digest to see ~70 entries.

## Phase 6 — SessionStart Hook

Goal: penumbra hooks install-digest adds hook that runs penumbra memory digest --maestro at session start.

Hook entry in ~/.claude/settings.json hooks.SessionStart:
```json
{"type": "command", "command": "/path/to/penumbra memory digest --maestro"}
```

Files: packages/cli/src/commands/hooks.ts (add runHooksInstallDigest, runHooksUninstallDigest), packages/cli/bin/penumbra.ts

Failing tests:
- adds SessionStart hook to settings.json
- uninstall removes the hook
- install is idempotent (no duplicate hooks)

Reversibility: Hook can be uninstalled. MEMORY.md continues to exist until Phase 7.
Demoable: YES — new CC session injects penumbra digest content.

## Phase 7 — Cutover

Goal: Archive CC file-memory directory after verifying import is correct and hook is running.

Verification checklist:
1. penumbra memory digest --maestro | wc -l shows >= 70 entries
2. SessionStart hook running for >= 1 session without errors
3. Compare digest against existing MEMORY.md — all active entries present

Cutover: mv ~/.claude/projects/.../memory/ ~/.claude/projects/.../memory.archived.2026-05-23/

Reversibility: mv is reversible. Penumbra entries not deleted. Both systems can coexist.
Demoable: YES — new system live end-to-end.

## Riskiest Assumptions

1. Curator retire sweep: If curator doesn't honor origin=direct guard, entries will be silently retired. Verify before Phase 5.
2. Embedder in CLI context: runMemoryImport via POST /memory/write requires daemon running. Add --direct flag to bypass HTTP if needed.
3. memory_links schema: Verify PRAGMA table_info(memory_links) before Phase 2 — column names assumed from code review.
4. Hook output size: 200 lines at ~80 chars = 16KB. Test with real data before cutover.
5. Recall pollution: After import, memory_recall may mix CC taxonomy entries with dreaming-promoted entries. cc_kind column allows filtering but callers won't know to use it.

## First Demoable Win

Phase 5:
```bash
penumbra memory import-from-claude-code --root ~/.claude/projects/.../memory/
penumbra memory digest --maestro
```
Expected: ~70 lines of - [title](slug) — hook matching existing CC memory contents.

## Implementation Order

| Phase | Description | Demoable | Risk |
|-------|-------------|----------|------|
| 1 | Schema migration | No | Low |
| 2 | Direct-write service + MCP tool | Yes (manual) | Medium |
| 3 | penumbra memory digest CLI | Yes (post-2) | Low |
| 4 | Import dry-run | No | Low |
| 5 | Import full run | YES — first win | Medium |
| 6 | SessionStart hook | Yes | Low |
| 7 | Cutover | YES | Low |
