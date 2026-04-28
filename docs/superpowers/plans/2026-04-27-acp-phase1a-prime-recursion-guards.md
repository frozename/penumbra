# ACP Phase 1a' — Recursion Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an ACP agent (with MCP injection from Phase 1a) calls `chain.start` to spawn a sub-agent, track the parent → child lineage, enforce a cumulative depth cap across the spawn tree, and reject runaway recursion before it consumes budget.

**Architecture:** Add a `parent_handoff_id` column to the `handoffs` table via the existing `addColumnIfMissing` migration pattern (no per-file migration directory in this codebase — it's a single `applySchema()` function). Thread the field through `HandoffRowSchema`, `CreateHandoffRequestSchema`, `ChainStartRequestSchema`, the `HandoffWriter` (`createApproved` is the chain.start path), and the `chain.start` route. Add a `getSpawnDepth()` method to `HandoffReader` that walks the parent chain. Reject `chain.start` if the new dispatch would exceed `PENUMBRA_RECURSION_DEPTH_CAP` (default 8). Surface `parent_handoff_id` in the MCP `chain-start` tool so ACP agents can pass it. Per-dispatch token budget and wall-clock timeout deferred to Phase 3.

**Tech Stack:** TypeScript, bun:sqlite, zod schemas, `bun test` (vitest-compatible).

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Modify | `packages/core/src/db/schema.ts` | Add `addColumnIfMissing(db, 'handoffs', 'parent_handoff_id', 'TEXT')` after the existing `worker_id` line. |
| Modify | `packages/core/src/schemas/handoff.ts` | Add `parent_handoff_id` to `HandoffRowSchema` and `CreateHandoffRequestSchema`. |
| Modify | `packages/core/src/schemas/chain.ts` | Add `parent_handoff_id` to `ChainStartRequestSchema` so the daemon route doesn't strip it. |
| Modify | `packages/core/src/writers/handoff.ts` | Thread `parent_handoff_id` through `CreateHandoffParams`, `CreateApprovedParams`, the `create()` INSERT, and the `createApproved()` INSERT (the chain.start path). |
| Modify | `packages/core/src/readers/handoff.ts` | Add `getSpawnDepth(handoff_id)` method on `HandoffReader`. |
| Modify | `packages/daemon/src/routes/chains.ts` | In `chainsStartRoute`, add depth-cap guard before calling `createApproved`. Pass `parent_handoff_id` to the writer. |
| Modify | `packages/mcp/src/tools/chain-start.ts` | Add `parent_handoff_id` to `ChainStartInputShape` and forward it in `chainStartHandler`. |
| Create | `packages/core/test/readers/handoff-spawn-depth.test.ts` | Tests for the depth-walking method. |
| Create | `packages/daemon/test/routes/chain-start-recursion.test.ts` | Tests for the depth-cap guard. |
| Modify | `packages/core/test/schemas/handoff.test.ts` | Add tests asserting both schemas accept `parent_handoff_id`. |

---

## Task 1: Add `parent_handoff_id` column to handoffs table

**Files:**
- Modify: `packages/core/src/db/schema.ts`

This codebase has **no per-file migration directory**. Schema changes are made by adding `addColumnIfMissing(...)` calls inside `applySchema()`. The pattern is established (see lines 198-204 for prior columns).

- [ ] **Step 1: Add the column line**

In `packages/core/src/db/schema.ts`, locate the block:

```ts
addColumnIfMissing(db, 'handoffs', 'use_worktree', 'INTEGER');
addColumnIfMissing(db, 'handoffs', 'resolution_reason', 'TEXT');
addColumnIfMissing(db, 'handoffs', 'error_message', 'TEXT');
addColumnIfMissing(db, 'handoffs', 'cancel_requested_at', 'TEXT');
addColumnIfMissing(db, 'handoffs', 'worker_id', 'TEXT');
```

Append a new line immediately after the `worker_id` line:

```ts
addColumnIfMissing(db, 'handoffs', 'parent_handoff_id', 'TEXT');
```

- [ ] **Step 2: Verify migration runs cleanly**

Run:

```bash
bun -e 'import { Database } from "bun:sqlite"; import { migrate } from "./packages/core/src/db/migrations.ts"; const db = new Database(":memory:"); migrate(db, { embeddingDim: 384 }); const cols = db.prepare("PRAGMA table_info(handoffs)").all(); const found = cols.find((c: any) => c.name === "parent_handoff_id"); console.log(JSON.stringify(found));'
```

Expected output:

```
{"cid":20,"name":"parent_handoff_id","type":"TEXT","notnull":0,"dflt_value":null,"pk":0}
```

(The `cid` may vary depending on column count.)

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0, no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/db/schema.ts
git commit -m "feat(core): handoffs.parent_handoff_id column for ACP recursion lineage"
```

---

## Task 2: Update HandoffRowSchema + CreateHandoffRequestSchema + ChainStartRequestSchema

**Files:**
- Modify: `packages/core/src/schemas/handoff.ts`
- Modify: `packages/core/src/schemas/chain.ts`
- Modify: `packages/core/test/schemas/handoff.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/core/test/schemas/handoff.test.ts`, append two new test cases. Use this exact test code (do not omit fields — the schema validates strictly):

```ts
test('HandoffRowSchema accepts parent_handoff_id', () => {
  const row = {
    handoff_id: 'h-1',
    ts: '2026-04-25T20:00:00.000Z',
    project_id: null,
    conversation_id: 'c-1',
    from_agent: 'a',
    to_agent: 'b',
    to_role: null,
    message: 'hi',
    status: 'pending' as const,
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: 'parent-h-id',
  };
  expect(HandoffRowSchema.safeParse(row).success).toBe(true);
});

test('HandoffRowSchema accepts null parent_handoff_id', () => {
  const row = {
    handoff_id: 'h-1', ts: '2026-04-25T20:00:00.000Z', project_id: null,
    conversation_id: 'c-1', from_agent: 'a', to_agent: 'b', to_role: null,
    message: 'hi', status: 'pending' as const,
    resolved_by: null, resolved_at: null, redirected_to: null,
    resolution_reason: null, triggered_by_event_id: null,
    chain_max_hops: null, chain_trust_mode: null, use_worktree: null,
    error_message: null, cancel_requested_at: null, worker_id: null,
    parent_handoff_id: null,
  };
  expect(HandoffRowSchema.safeParse(row).success).toBe(true);
});

test('CreateHandoffRequestSchema accepts optional parent_handoff_id', () => {
  const ok = CreateHandoffRequestSchema.safeParse({
    from: 'a', to: 'b', message: 'go',
    conversation_id: 'c', triggered_by_event_id: 'e',
    parent_handoff_id: 'parent-h-id',
  });
  expect(ok.success).toBe(true);

  const okOmitted = CreateHandoffRequestSchema.safeParse({
    from: 'a', to: 'b', message: 'go',
    conversation_id: 'c', triggered_by_event_id: 'e',
  });
  expect(okOmitted.success).toBe(true);
});
```

Verify imports at the top of the file already cover `HandoffRowSchema` and `CreateHandoffRequestSchema`. If missing, add them.

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/core/test/schemas/handoff.test.ts -t "parent_handoff_id"`

Expected: 3 tests, all FAIL — for `HandoffRowSchema` cases the failure is "row validates but extra key is rejected" or similar zod strict-parse error; for `CreateHandoffRequestSchema` similar.

- [ ] **Step 3: Add the field to HandoffRowSchema**

In `packages/core/src/schemas/handoff.ts`, locate `HandoffRowSchema`. Add `parent_handoff_id: z.string().nullable(),` as the last field in the object literal (after `worker_id`):

```ts
export const HandoffRowSchema = z.object({
  // ... existing fields ...
  worker_id: z.string().nullable(),
  parent_handoff_id: z.string().nullable(),
});
```

- [ ] **Step 4: Add the field to CreateHandoffRequestSchema**

In the same file, locate `CreateHandoffRequestSchema`. Add `parent_handoff_id: z.string().min(1).optional(),` as the last field:

```ts
export const CreateHandoffRequestSchema = z.object({
  // ... existing fields ...
  use_worktree: z.preprocess(/* existing */),
  parent_handoff_id: z.string().min(1).optional(),
});
```

- [ ] **Step 5: Add the field to ChainStartRequestSchema**

In `packages/core/src/schemas/chain.ts`, locate `ChainStartRequestSchema`. Add `parent_handoff_id: z.string().min(1).optional(),` as the last field:

```ts
export const ChainStartRequestSchema = z.object({
  // ... existing fields ...
  use_worktree: z.preprocess(
    (v) => (v === 1 ? true : v === 0 ? false : v),
    z.boolean().nullable().optional(),
  ),
  parent_handoff_id: z.string().min(1).optional(),
});
```

This step is **critical**: without it, `ChainStartRequestSchema.safeParse(raw)` in the daemon route silently strips `parent_handoff_id` and the guard never fires.

- [ ] **Step 6: Run tests to verify pass**

Run: `bun test packages/core/test/schemas/handoff.test.ts`

Expected: all tests pass; pre-existing tests not regressed.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schemas/handoff.ts packages/core/src/schemas/chain.ts packages/core/test/schemas/handoff.test.ts
git commit -m "feat(core): handoff + chain schemas — accept parent_handoff_id"
```

---

## Task 3: Persist `parent_handoff_id` in HandoffWriter

**Files:**
- Modify: `packages/core/src/writers/handoff.ts`

The writer has **two relevant INSERT statements** (verified via the `chain.start` route, which uses `createApproved`):

- `create()` — pending handoffs (not used by chain.start today, but keep the API consistent)
- `createApproved()` — the route we care about; `chain.start` calls this

Both need plumbing.

- [ ] **Step 1: Update `CreateHandoffParams` interface**

`CreateHandoffParams` already extends `CreateHandoffRequest`, so once the schema field is added (Task 2 Step 4), `parent_handoff_id` is automatically part of the type. No change needed.

- [ ] **Step 2: Update `CreateApprovedParams` interface**

`CreateApprovedParams` is a standalone interface (does NOT extend the schema type). Add the field:

```ts
export interface CreateApprovedParams {
  // ... existing fields ...
  use_worktree: boolean | null;
  parent_handoff_id: string | null;
}
```

- [ ] **Step 3: Update the `create()` INSERT**

Locate (around lines 48-62 of `writers/handoff.ts`):

```ts
create(params: CreateHandoffParams): string {
  this.db
    .query<unknown, [string, string, string | null, string, string, string, string | null, string, string | null, number | null]>(
      `INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id,
        from_agent, to_agent, to_role, message, status, triggered_by_event_id, use_worktree
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      params.handoff_id, params.ts, params.project_id ?? null,
      params.conversation_id, params.from, params.to, params.to_role ?? null,
      params.message, params.triggered_by_event_id, params.use_worktree ? 1 : (params.use_worktree === false ? 0 : null),
    );
  return params.handoff_id;
}
```

Replace with:

```ts
create(params: CreateHandoffParams): string {
  this.db
    .query<unknown, [string, string, string | null, string, string, string, string | null, string, string | null, number | null, string | null]>(
      `INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id,
        from_agent, to_agent, to_role, message, status, triggered_by_event_id, use_worktree, parent_handoff_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      params.handoff_id, params.ts, params.project_id ?? null,
      params.conversation_id, params.from, params.to, params.to_role ?? null,
      params.message, params.triggered_by_event_id,
      params.use_worktree ? 1 : (params.use_worktree === false ? 0 : null),
      params.parent_handoff_id ?? null,
    );
  return params.handoff_id;
}
```

- [ ] **Step 4: Update the `createApproved()` INSERT**

Locate `createApproved()` (around lines 64-85). Apply the same pattern: append `parent_handoff_id` to the column list, add a `?` placeholder, append the binding to the type tuple and to `.run()` arguments.

Resulting INSERT column list:

```sql
INSERT INTO handoffs (
  handoff_id, ts, project_id, conversation_id,
  from_agent, to_agent, to_role, message, status,
  resolved_by, resolved_at, chain_max_hops, chain_trust_mode, triggered_by_event_id, use_worktree, parent_handoff_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)
```

Add to `.run()` arguments at the end: `params.parent_handoff_id ?? null,`

Update the type tuple to include one extra `string | null`.

- [ ] **Step 5: Run writer tests**

Run: `bun test packages/core/test/writers/`

Expected: all pre-existing tests pass. If a test exercises `createApproved` and asserts a specific row shape, the new column with NULL value should not break it.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/writers/handoff.ts
git commit -m "feat(core): handoff writer — persist parent_handoff_id in create + createApproved"
```

---

## Task 4: Add `HandoffReader.getSpawnDepth()` method

**Files:**
- Modify: `packages/core/src/readers/handoff.ts`
- Create: `packages/core/test/readers/handoff-spawn-depth.test.ts`

The reader is class-based. Add `getSpawnDepth()` as a method on `HandoffReader`. The method walks `parent_handoff_id` upward, counting hops, until it hits a row with `parent_handoff_id IS NULL` (a user-initiated dispatch). Caps at a sanity limit to defend against malformed cycles.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/readers/handoff-spawn-depth.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../../src/db/migrations.js';
import { HandoffReader } from '../../src/readers/handoff.js';

let db: Database;
let reader: HandoffReader;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, { embeddingDim: 384 });
  reader = new HandoffReader({ db });
});

function insertHandoff(id: string, parent: string | null) {
  db.prepare(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, parent_handoff_id)
    VALUES (?, datetime('now'), 'c', 'a', 'b', 'm', 'pending', ?)
  `).run(id, parent);
}

test('getSpawnDepth returns 0 for root handoff (no parent)', () => {
  insertHandoff('h-root', null);
  expect(reader.getSpawnDepth('h-root')).toBe(0);
});

test('getSpawnDepth returns 1 for direct child', () => {
  insertHandoff('h-root', null);
  insertHandoff('h-child', 'h-root');
  expect(reader.getSpawnDepth('h-child')).toBe(1);
});

test('getSpawnDepth returns N for N-deep chain', () => {
  insertHandoff('h-0', null);
  insertHandoff('h-1', 'h-0');
  insertHandoff('h-2', 'h-1');
  insertHandoff('h-3', 'h-2');
  expect(reader.getSpawnDepth('h-3')).toBe(3);
});

test('getSpawnDepth returns 0 for unknown handoff_id', () => {
  expect(reader.getSpawnDepth('nonexistent')).toBe(0);
});

test('getSpawnDepth caps at sanity limit on cycle', () => {
  // Force a cycle by writing a parent that points to self
  insertHandoff('h-cycle', 'h-cycle');
  // Should return the sanity cap (64), not infinite loop
  expect(reader.getSpawnDepth('h-cycle')).toBeGreaterThanOrEqual(64);
});

test('getSpawnDepth returns 0 when intermediate row vanishes', () => {
  // Edge: parent_handoff_id points to a row that no longer exists.
  // Walk should stop and return what it counted (1) rather than loop forever.
  insertHandoff('h-orphan', 'h-missing');
  expect(reader.getSpawnDepth('h-orphan')).toBe(1);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/core/test/readers/handoff-spawn-depth.test.ts`

Expected: FAIL — `reader.getSpawnDepth is not a function`.

- [ ] **Step 3: Implement the method**

In `packages/core/src/readers/handoff.ts`, inside the `HandoffReader` class, add:

```ts
/**
 * Walks parent_handoff_id upward, counting hops until a root handoff
 * (parent_handoff_id IS NULL) is reached. Caps at SPAWN_DEPTH_SANITY_CAP
 * (64) to defend against malformed cycles. Returns 0 for root handoffs
 * and for unknown handoff_ids.
 *
 * Used by chain.start to enforce a cumulative recursion depth cap on
 * ACP-spawned chains.
 */
getSpawnDepth(handoff_id: string): number {
  const SPAWN_DEPTH_SANITY_CAP = 64;
  const stmt = this.db.query<{ parent_handoff_id: string | null }, [string]>(
    `SELECT parent_handoff_id FROM handoffs WHERE handoff_id=?`
  );
  let cur: string = handoff_id;
  for (let i = 0; i < SPAWN_DEPTH_SANITY_CAP; i++) {
    const row = stmt.get(cur);
    if (!row || !row.parent_handoff_id) return i;
    cur = row.parent_handoff_id;
  }
  return SPAWN_DEPTH_SANITY_CAP;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/core/test/readers/handoff-spawn-depth.test.ts`

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/readers/handoff.ts packages/core/test/readers/handoff-spawn-depth.test.ts
git commit -m "feat(core): HandoffReader.getSpawnDepth — walk parent chain for recursion guard"
```

---

## Task 5: chain.start enforces the depth cap

**Files:**
- Modify: `packages/daemon/src/routes/chains.ts`
- Create: `packages/daemon/test/routes/chain-start-recursion.test.ts`

Default cap: `PENUMBRA_RECURSION_DEPTH_CAP=8`. Override via env var. Read at request time (per-tick, not constructor-time — see prior fix in observation 8351).

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/chain-start-recursion.test.ts`:

```ts
import { expect, test, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { chainsStartRoute } from '../../src/routes/chains.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {}, input: {}, storageRoot: '/tmp/recursion-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-27T00:00:00Z'),
    uuid: () => `id-${++n}`,
    agentRegistry: ['planner', 'executor'],
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
}

function seedChain(services: Services, depth: number): string {
  // Insert a chain of 'depth' handoffs. Returns the leaf handoff_id.
  // Inserts directly; no ts collisions matter for the depth walk.
  let prev: string | null = null;
  let last = '';
  for (let i = 0; i < depth; i++) {
    const id = `seed-h-${i}`;
    services.db.prepare(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, parent_handoff_id)
      VALUES (?, datetime('now'), 'seed-c', 'a', 'b', 'm', 'completed', ?)
    `).run(id, prev);
    prev = id;
    last = id;
  }
  return last;
}

afterEach(() => {
  delete process.env.PENUMBRA_RECURSION_DEPTH_CAP;
});

test('chain.start without parent_handoff_id passes recursion guard', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }),
  }), services);
  expect(res.status).toBe(200);
});

test('chain.start with a parent at depth 7 passes (one below cap=8)', async () => {
  const services = tempServices();
  const parentLeaf = seedChain(services, 7); // depths 0..6, parentLeaf at depth 6
  // New dispatch with parent=parentLeaf would land at depth 7 → under cap of 8.
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', parent_handoff_id: parentLeaf }),
  }), services);
  expect(res.status).toBe(200);
});

test('chain.start at depth 8 (at cap) rejects with recursion_depth_exceeded', async () => {
  const services = tempServices();
  const parentLeaf = seedChain(services, 8); // depths 0..7, parentLeaf at depth 7
  // New dispatch would be depth 8 → equals cap → reject.
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', parent_handoff_id: parentLeaf }),
  }), services);
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error.code).toBe('recursion_depth_exceeded');
  expect(body.error.depth).toBe(8);
  expect(body.error.cap).toBe(8);
});

test('PENUMBRA_RECURSION_DEPTH_CAP env var raises the cap', async () => {
  process.env.PENUMBRA_RECURSION_DEPTH_CAP = '16';
  const services = tempServices();
  const parentLeaf = seedChain(services, 9); // would reject under default cap
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', parent_handoff_id: parentLeaf }),
  }), services);
  expect(res.status).toBe(200);
});

test('chain.start with unknown parent_handoff_id treats depth as 0 and passes', async () => {
  // If parent doesn't exist, getSpawnDepth returns 0; new dispatch is depth 1.
  // This is permissive by design — better to allow than to fail closed on stale ids.
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', parent_handoff_id: 'nonexistent-id' }),
  }), services);
  expect(res.status).toBe(200);
});

test('chain.start persists parent_handoff_id when provided', async () => {
  const services = tempServices();
  const parentLeaf = seedChain(services, 1);
  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', parent_handoff_id: parentLeaf }),
  }), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.parent_handoff_id).toBe(parentLeaf);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/daemon/test/routes/chain-start-recursion.test.ts`

Expected: 6 tests, the depth-cap and persistence cases FAIL — guard not implemented, parent_handoff_id not persisted.

- [ ] **Step 3: Implement the guard in chainsStartRoute**

In `packages/daemon/src/routes/chains.ts`, inside `chainsStartRoute`, after the `agentRegistry.includes` validation (around line 60) and BEFORE the `services.db.transaction(() => { ... })` block, add the guard:

```ts
// Recursion depth guard: if parent_handoff_id is provided, walk the spawn
// chain and reject if the new dispatch would exceed the cap. Reads env var
// per-request (per observation 8351 — constructor-time latch is wrong).
if (parsed.data.parent_handoff_id) {
  const cap = Number(process.env.PENUMBRA_RECURSION_DEPTH_CAP) || 8;
  const parentDepth = services.handoffReader.getSpawnDepth(parsed.data.parent_handoff_id);
  const newDepth = parentDepth + 1;
  if (newDepth >= cap) {
    return json({
      error: {
        code: 'recursion_depth_exceeded',
        message: `chain.start spawn depth ${newDepth} would meet/exceed cap ${cap}`,
        depth: newDepth,
        cap,
      },
    }, 409);
  }
}
```

(Note: comparison is `newDepth >= cap` so cap=8 rejects depth=8. The test seeds 8-deep chain → leaf is at depth 7 → new dispatch is depth 8 → rejected. Test seeds 7-deep chain → leaf at depth 6 → new dispatch depth 7 → allowed.)

Then update the existing `services.handoffWriter.createApproved({ ... })` call inside the transaction to pass the new field:

```ts
services.handoffWriter.createApproved({
  handoff_id, ts,
  project_id: parsed.data.project_id ?? null,
  conversation_id,
  from: 'user',
  to: parsed.data.initial_agent,
  to_role: null,
  message: parsed.data.message,
  triggered_by_event_id: user_prompt_event_id,
  resolved_by: 'chain-start',
  resolved_at: ts,
  chain_max_hops: parsed.data.max_hops ?? null,
  chain_trust_mode: parsed.data.trust_mode ?? null,
  use_worktree: parsed.data.use_worktree ?? null,
  parent_handoff_id: parsed.data.parent_handoff_id ?? null,
});
```

- [ ] **Step 4: Run new tests to verify pass**

Run: `bun test packages/daemon/test/routes/chain-start-recursion.test.ts`

Expected: 6 tests pass.

- [ ] **Step 5: Run full daemon test suite for regression check**

Run: `bun test packages/daemon/test/`

Expected: all pre-existing tests pass. The pre-existing chain.start tests don't pass `parent_handoff_id`, so they should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/routes/chains.ts packages/daemon/test/routes/chain-start-recursion.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): chain.start — enforce recursion depth cap (default 8)

When parent_handoff_id is provided, walk the spawn chain via
HandoffReader.getSpawnDepth and reject if the new dispatch would
meet or exceed PENUMBRA_RECURSION_DEPTH_CAP (default 8). Returns
HTTP 409 with recursion_depth_exceeded error code carrying both
depth and cap fields. Phase 1a' of the ACP roadmap.
EOF
)"
```

---

## Task 6: Surface `parent_handoff_id` in chain-start MCP tool

**Files:**
- Modify: `packages/mcp/src/tools/chain-start.ts`

The MCP tool's input schema must accept `parent_handoff_id` so an ACP agent calling `chain.start` during its turn can pass it. The handler must forward it (the file uses an explicit allowlist of forwarded keys).

- [ ] **Step 1: Add to ChainStartInputShape**

In `packages/mcp/src/tools/chain-start.ts`, add the following entry to `ChainStartInputShape` (after `use_worktree`):

```ts
parent_handoff_id: z.string().min(1).optional().describe(
  'Optional handoff ID this dispatch is spawned from. Used by ACP agents calling chain.start during their turn so penumbra can enforce a recursion depth cap. Omit for user-initiated dispatches.'
),
```

- [ ] **Step 2: Forward the field in chainStartHandler**

In the same file, add to the explicit forward block:

```ts
if (input.parent_handoff_id !== undefined) body.parent_handoff_id = input.parent_handoff_id;
```

(Place it after the existing `use_worktree` line for consistency.)

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 4: Run MCP tests**

Run: `bun test packages/mcp/test/`

Expected: all pre-existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/chain-start.ts
git commit -m "feat(mcp): chain.start tool — accept and forward parent_handoff_id"
```

---

## End-to-end worked example

After all tasks land, the recursion guard manifests as follows:

**Setup:** ACP agent `claude-acp-sonnet` is dispatched by the user (depth 0). It has `mcpServers: [penumbra-mcp]` injected (Phase 1a). During its turn it calls the `chain.start` MCP tool to spawn a sub-agent.

**Successful spawn at depth 1:**
```json
// ACP agent sends:
{ "tool": "chain.start", "input": {
    "initial_agent": "planner",
    "message": "research X",
    "parent_handoff_id": "h-claude-001"  // its own handoff_id
  }
}
// Daemon route:
//   parsed.data.parent_handoff_id = "h-claude-001"
//   getSpawnDepth("h-claude-001") = 0  (root user dispatch)
//   newDepth = 1
//   1 < 8 → pass → createApproved with parent_handoff_id="h-claude-001"
// Returns: { conversation_id: "...", handoff_id: "h-planner-001" }
```

**Recursion runaway rejected at depth 8:**

Suppose the chain has spawned 8 layers deep (claude → planner → researcher → ... → analyst at depth 7). The analyst tries to spawn another:
```json
{ "tool": "chain.start", "input": {
    "initial_agent": "summarizer",
    "message": "...",
    "parent_handoff_id": "h-analyst-001"  // depth 7
  }
}
// Daemon route:
//   getSpawnDepth("h-analyst-001") = 7
//   newDepth = 8
//   8 >= 8 → reject
// Returns HTTP 409:
//   { error: { code: "recursion_depth_exceeded", depth: 8, cap: 8, message: "..." } }
```

The MCP tool surfaces this as an error to the analyst, who handles it in its prompt (e.g., "if you can't spawn further, return a partial result").

**Operator override:**
```bash
PENUMBRA_RECURSION_DEPTH_CAP=16 bun packages/daemon/bin/penumbra-daemon.ts ...
# Now the cap is 16. Useful for legitimate deep research chains.
```

---

## Verification — does the plan cover the spec?

| Spec line | Task |
|---|---|
| Track parent_handoff_id lineage on handoffs table | Task 1 (column) |
| Surface parent_handoff_id in MCP for ACP agents | Task 6 |
| Cumulative depth cap walking parent chain | Task 4 (`getSpawnDepth`) |
| Configurable cap (default 8) via env var | Task 5 |
| Schema acceptance at all four layers | Task 2 (HandoffRowSchema, CreateHandoffRequestSchema, ChainStartRequestSchema) |
| Writer plumbing for both INSERT paths | Task 3 (`create` + `createApproved`) |
| Per-dispatch token budget | NOT in this plan — landed with Phase 3 cost ledger |
| Per-dispatch wall-clock timeout | NOT in this plan — handled by existing handoff sweeper TTL + Phase 3 |

Token budget and wall-clock timeout deferred intentionally; they need cost-ledger plumbing from Phase 3 and would otherwise duplicate logic.

## Estimated effort

- Task 1 (schema column): 5 min
- Task 2 (three schemas + tests): 20 min
- Task 3 (writer two INSERTs): 15 min
- Task 4 (HandoffReader.getSpawnDepth + 6 tests): 30 min
- Task 5 (chain.start guard + 6 tests): 45 min
- Task 6 (MCP tool): 10 min

Total: ~2 hours focused work.
