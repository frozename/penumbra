# ACP Phase 1a' — Recursion Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an ACP agent (with MCP injection from Phase 1a) calls `chain.start` to spawn a sub-agent, track the parent → child lineage, enforce a cumulative depth cap across the spawn tree, and reject runaway recursion before it consumes budget.

**Architecture:** Add a `parent_handoff_id` column to the handoffs table. Pass it through chain.start's MCP tool. Compute spawn depth by walking the parent chain at validation time. Reject chain.start if depth exceeds a configurable cap (default 8). Per-dispatch token budget and wall-clock timeout deferred to Phase 3 (cost ledger has the right plumbing).

**Tech Stack:** TypeScript, bun:sqlite migration, zod schemas, vitest tests.

---

## File Structure

- **Create**: `packages/core/src/db/migrations/<NN>-handoffs-parent.ts` — adds `parent_handoff_id` column.
- **Modify**: `packages/core/src/schemas/handoff.ts` — add field to `HandoffRowSchema` + `CreateHandoffRequestSchema`.
- **Modify**: `packages/core/src/writers/handoff.ts` — accept + persist `parent_handoff_id`.
- **Modify**: `packages/core/src/readers/handoff.ts` (or wherever handoff reads live) — add `getHandoffSpawnDepth(handoff_id)` walking the parent chain.
- **Modify**: `packages/daemon/src/routes/conversations.ts` (or wherever chain.start lives) — accept `parent_handoff_id` param, validate depth.
- **Modify**: `packages/mcp/src/tools/chain-start.ts` — surface `parent_handoff_id` in the MCP tool schema (for ACP agents to pass).
- **Test**: `packages/core/test/readers/handoff-spawn-depth.test.ts` — depth-walking logic.
- **Test**: `packages/daemon/test/routes/chain-start-recursion.test.ts` — depth cap enforcement.

---

## Task 1: Add `parent_handoff_id` migration

**Files:**
- Create: `packages/core/src/db/migrations/<next-number>-handoffs-parent.ts`

Find the next migration number first:

- [ ] **Step 1: Find migration numbering convention**

Run: `ls packages/core/src/db/migrations/ | tail -5`

Expected: filenames like `0042-some-name.ts`. Note the highest number; new file uses N+1.

- [ ] **Step 2: Create the migration**

Replace `<NN>` with the next sequence number (e.g., `0043`).

Create `packages/core/src/db/migrations/<NN>-handoffs-parent.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { addColumnIfMissing } from '../addColumnIfMissing.js';

/**
 * Adds parent_handoff_id to track ACP agent → sub-dispatch lineage.
 * Used by chain.start depth guard to prevent runaway recursion.
 */
export function up(db: Database): void {
  addColumnIfMissing(db, 'handoffs', 'parent_handoff_id', 'TEXT');
}
```

- [ ] **Step 3: Register the migration**

Run: `grep -n 'migrations/' packages/core/src/db/migrate.ts | head -5`

Expected: a registration array or import block. Add the new migration following the existing pattern (likely `import { up as up0043 } from './migrations/0043-handoffs-parent.js'` + `migrations.push({ number: 43, up: up0043 })`).

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 5: Verify migration runs cleanly**

Run: `bun -e 'import { Database } from "bun:sqlite"; import { migrate } from "./packages/core/src/db/migrate.ts"; const db = new Database(":memory:"); migrate(db); const row = db.prepare("PRAGMA table_info(handoffs)").all(); console.log(row.find((r:any) => r.name === "parent_handoff_id"));'`

Expected: prints `{ cid: ..., name: 'parent_handoff_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/migrations/<NN>-handoffs-parent.ts packages/core/src/db/migrate.ts
git commit -m "feat(core): handoffs.parent_handoff_id column for ACP recursion lineage"
```

---

## Task 2: Update HandoffRowSchema + CreateHandoffRequestSchema

**Files:**
- Modify: `packages/core/src/schemas/handoff.ts`
- Test: `packages/core/test/schemas/handoff.test.ts`

- [ ] **Step 1: Write the failing test**

Open `packages/core/test/schemas/handoff.test.ts` and add inside the existing test for `HandoffRowSchema validates a complete row`:

```ts
test('HandoffRowSchema accepts parent_handoff_id', () => {
  const row = {
    handoff_id: 'h-1', ts: '2026-04-25T20:00:00.000Z', project_id: null,
    conversation_id: 'c-1', from_agent: 'a', to_agent: 'b', to_role: null,
    message: 'hi', status: 'pending' as const, resolved_by: null, resolved_at: null,
    redirected_to: null, resolution_reason: null, triggered_by_event_id: null,
    chain_max_hops: null, chain_trust_mode: null, error_message: null,
    cancel_requested_at: null, worker_id: null, use_worktree: null,
    parent_handoff_id: 'parent-h-id',
  };
  expect(HandoffRowSchema.safeParse(row).success).toBe(true);
});

test('CreateHandoffRequestSchema accepts parent_handoff_id', () => {
  const ok = CreateHandoffRequestSchema.safeParse({
    from: 'a', to: 'b', message: 'go', conversation_id: 'c', triggered_by_event_id: 'e',
    parent_handoff_id: 'parent-h-id',
  });
  expect(ok.success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/core/test/schemas/handoff.test.ts -t "parent_handoff_id"`

Expected: FAIL with "unrecognized key" or similar.

- [ ] **Step 3: Add the field to the schemas**

In `packages/core/src/schemas/handoff.ts`, find `HandoffRowSchema` and `CreateHandoffRequestSchema`. Add:

```ts
// In HandoffRowSchema's shape
parent_handoff_id: z.string().nullable(),

// In CreateHandoffRequestSchema's shape
parent_handoff_id: z.string().min(1).optional(),
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/core/test/schemas/handoff.test.ts -t "parent_handoff_id"`

Expected: 2 pass.

- [ ] **Step 5: Run full handoff schema test file**

Run: `bun test packages/core/test/schemas/handoff.test.ts`

Expected: all tests pass; pre-existing tests not regressed.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas/handoff.ts packages/core/test/schemas/handoff.test.ts
git commit -m "feat(core): handoff schemas — accept parent_handoff_id"
```

---

## Task 3: Update handoff writer to persist parent_handoff_id

**Files:**
- Modify: `packages/core/src/writers/handoff.ts`
- Test: existing handoff writer tests in `packages/core/test/writers/`

- [ ] **Step 1: Locate the INSERT statement in the writer**

Run: `grep -n 'INSERT INTO handoffs' packages/core/src/writers/handoff.ts`

Expected: a prepared statement with the handoffs columns. Note the column list and the bound parameters.

- [ ] **Step 2: Add parent_handoff_id to the INSERT**

In `packages/core/src/writers/handoff.ts`, find the INSERT statement (e.g.):

```ts
const stmt = db.prepare(`
  INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status, ..., worker_id, use_worktree)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ..., ?, ?)
`);
```

Add `parent_handoff_id` to both column list and VALUES placeholders. Update the `.run()` call to pass `params.parent_handoff_id ?? null`.

- [ ] **Step 3: Run writer tests**

Run: `bun test packages/core/test/writers/handoff.test.ts` (adjust if filename differs — check `ls packages/core/test/writers/`).

Expected: all pass. If a test asserts exact column count in the INSERT, update it.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/writers/handoff.ts packages/core/test/writers/handoff.test.ts
git commit -m "feat(core): handoff writer — persist parent_handoff_id"
```

---

## Task 4: Add `getHandoffSpawnDepth` reader

**Files:**
- Create or Modify: `packages/core/src/readers/handoff.ts` (add the helper)
- Create: `packages/core/test/readers/handoff-spawn-depth.test.ts`

The helper walks `parent_handoff_id` upward, counting hops, until it hits a row with `parent_handoff_id IS NULL` (a user-initiated dispatch). Caps at a sanity limit to avoid cycles.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/readers/handoff-spawn-depth.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { getHandoffSpawnDepth } from '../../src/readers/handoff.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

function insertHandoff(id: string, parent: string | null) {
  db.prepare(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, parent_handoff_id)
    VALUES (?, datetime('now'), 'c', 'a', 'b', 'm', 'pending', ?)
  `).run(id, parent);
}

test('returns 0 for root handoff (no parent)', () => {
  insertHandoff('h-root', null);
  expect(getHandoffSpawnDepth(db, 'h-root')).toBe(0);
});

test('returns 1 for direct child', () => {
  insertHandoff('h-root', null);
  insertHandoff('h-child', 'h-root');
  expect(getHandoffSpawnDepth(db, 'h-child')).toBe(1);
});

test('returns N for N-deep chain', () => {
  insertHandoff('h-0', null);
  insertHandoff('h-1', 'h-0');
  insertHandoff('h-2', 'h-1');
  insertHandoff('h-3', 'h-2');
  expect(getHandoffSpawnDepth(db, 'h-3')).toBe(3);
});

test('returns 0 for unknown handoff_id', () => {
  expect(getHandoffSpawnDepth(db, 'nonexistent')).toBe(0);
});

test('caps at sanity limit on cycle', () => {
  // Force a cycle by writing a parent that points to self
  insertHandoff('h-cycle', 'h-cycle');
  // Should return the sanity cap (e.g., 64), not infinite loop
  expect(getHandoffSpawnDepth(db, 'h-cycle')).toBeGreaterThanOrEqual(64);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/core/test/readers/handoff-spawn-depth.test.ts`

Expected: FAIL — `getHandoffSpawnDepth` not exported.

- [ ] **Step 3: Implement the helper**

In `packages/core/src/readers/handoff.ts`, add:

```ts
const SPAWN_DEPTH_SANITY_CAP = 64;

/**
 * Returns the number of `parent_handoff_id` hops from this handoff up to a
 * root handoff (one with parent_handoff_id IS NULL). Used by chain.start to
 * enforce a cumulative depth cap on ACP-spawned recursion.
 *
 * Returns 0 for root handoffs and for unknown handoff_ids. Caps at
 * SPAWN_DEPTH_SANITY_CAP to defend against malformed cycles.
 */
export function getHandoffSpawnDepth(db: Database, handoff_id: string): number {
  const stmt = db.prepare<{ parent_handoff_id: string | null }, [string]>(
    'SELECT parent_handoff_id FROM handoffs WHERE handoff_id = ?'
  );
  let cur = handoff_id;
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

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/readers/handoff.ts packages/core/test/readers/handoff-spawn-depth.test.ts
git commit -m "feat(core): getHandoffSpawnDepth — walks parent chain for recursion guard"
```

---

## Task 5: chain.start enforces depth cap

**Files:**
- Modify: `packages/daemon/src/routes/conversations.ts` (or wherever `chain.start` lives — find via `grep -rn 'chain.start\|chains/start' packages/daemon/src/routes/`)
- Test: `packages/daemon/test/routes/chain-start-recursion.test.ts`

Default cap: `PENUMBRA_RECURSION_DEPTH_CAP=8`. Override via env var.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/chain-start-recursion.test.ts`:

```ts
import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '@penumbra/core';
// ... import whatever harness the existing chain.start tests use

// Test 1: chain.start with no parent_handoff_id succeeds (depth 0 is fine)
test('chain.start without parent_handoff_id passes recursion guard', async () => {
  // ... call chain.start, expect 200
});

// Test 2: chain.start with a parent at depth 7 succeeds (just under cap)
test('chain.start at depth 7 (one below cap) passes', async () => {
  // ... seed 7-deep chain, call chain.start with parent at depth 7, expect 200
});

// Test 3: chain.start with a parent at depth 8 (at cap) rejects
test('chain.start at depth 8 (at cap) rejects with recursion_depth_exceeded', async () => {
  // ... seed 8-deep chain, call chain.start, expect 400/409 with that error code
});

// Test 4: env var override raises the cap
test('PENUMBRA_RECURSION_DEPTH_CAP env var overrides default', async () => {
  process.env.PENUMBRA_RECURSION_DEPTH_CAP = '16';
  // ... seed 9-deep chain, call chain.start, expect 200 (would have rejected at default 8)
  delete process.env.PENUMBRA_RECURSION_DEPTH_CAP;
});
```

Adapt the harness/imports to match the existing `chain-start.test.ts` style. Look at `packages/daemon/test/routes/conversations.test.ts` or similar for the testing pattern (likely uses `createServices()` + a fetch-style test client).

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/daemon/test/routes/chain-start-recursion.test.ts`

Expected: FAIL — guard not implemented.

- [ ] **Step 3: Implement the guard in chain.start**

Find the chain.start handler. After validating other inputs (initial_agent existence, message non-empty, etc.) and BEFORE inserting the handoff, add:

```ts
// Recursion guard: if parent_handoff_id is provided, verify spawn depth is under cap
if (req.parent_handoff_id) {
  const cap = Number(process.env.PENUMBRA_RECURSION_DEPTH_CAP) || 8;
  const parentDepth = getHandoffSpawnDepth(services.db, req.parent_handoff_id);
  // The new handoff would be at depth parentDepth + 1
  if (parentDepth + 1 > cap) {
    return json({
      error: {
        code: 'recursion_depth_exceeded',
        message: `chain.start spawn depth ${parentDepth + 1} exceeds cap ${cap}`,
        depth: parentDepth + 1,
        cap,
      },
    }, 409);
  }
}
```

Import `getHandoffSpawnDepth` from `@penumbra/core`. Adjust the response helper (`json`) to match what the route uses.

Persist `req.parent_handoff_id` when constructing the handoff row to insert (passes through to the writer from Task 3).

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/daemon/test/routes/chain-start-recursion.test.ts`

Expected: 4 pass.

- [ ] **Step 5: Run full daemon test suite for no regressions**

Run: `bun test packages/daemon/test/`

Expected: all pre-existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/routes/conversations.ts packages/daemon/test/routes/chain-start-recursion.test.ts
git commit -m "feat(daemon): chain.start — enforce recursion depth cap (default 8)

When parent_handoff_id is provided, walk the spawn chain and reject if depth
would exceed PENUMBRA_RECURSION_DEPTH_CAP (default 8). Returns HTTP 409 with
recursion_depth_exceeded error code. Phase 1a' of the ACP roadmap."
```

---

## Task 6: Surface `parent_handoff_id` in chain.start MCP tool

**Files:**
- Modify: `packages/mcp/src/tools/chain-start.ts`
- Test: existing MCP tool tests

The MCP tool's input schema needs to accept `parent_handoff_id` so an ACP agent calling chain.start during its turn can pass it.

- [ ] **Step 1: Find the chain.start MCP tool**

Run: `cat packages/mcp/src/tools/chain-start.ts | head -30`

Expected: a zod schema describing tool inputs (initial_agent, message, conversation_id, max_hops, trust_mode, use_worktree, project_id).

- [ ] **Step 2: Add parent_handoff_id to the schema**

Add the field:

```ts
parent_handoff_id: z.string().min(1).optional().describe(
  'Optional handoff ID this dispatch is spawned from. Used by ACP agents calling chain.start during their turn so penumbra can enforce a recursion depth cap. Omit for user-initiated dispatches.'
),
```

Pass `parent_handoff_id` through to the daemon client call.

- [ ] **Step 3: Run MCP tool tests**

Run: `bun test packages/mcp/test/tools/`

Expected: all pass; existing tests don't regress.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/tools/chain-start.ts
git commit -m "feat(mcp): chain.start tool — accept parent_handoff_id for ACP recursion guard"
```

---

## Verification — does the plan cover the spec?

| Spec line | Task |
|---|---|
| Track parent_handoff_id lineage | Task 1 (column) + Task 3 (writer) |
| Surface parent_handoff_id in MCP for ACP agents | Task 6 |
| Cumulative depth cap across spawn tree | Task 4 (depth walker) + Task 5 (enforcement) |
| Configurable cap (default 8) | Task 5 (env var) |
| Per-dispatch token budget | NOT in this plan — landed with Phase 3 cost ledger |
| Per-dispatch wall-clock timeout | NOT in this plan — handled by existing handoff sweeper TTL + Phase 3 |

Token budget and wall-clock timeout deferred intentionally; they need the cost ledger plumbing from Phase 3 and would otherwise duplicate logic.

## Estimated effort

- Task 1 (migration): 10 min
- Task 2 (schemas): 15 min
- Task 3 (writer): 10 min
- Task 4 (depth walker + tests): 30 min
- Task 5 (chain.start guard + tests): 45 min
- Task 6 (MCP tool): 10 min

Total: ~2 hours focused work.
