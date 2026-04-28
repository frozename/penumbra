# ACP Phase 1c v2 — Operator-in-the-Loop Permission Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 "blanket reject under `chain_trust_mode='config'`" behavior with an operator-in-the-loop permission flow. Tools on a per-agent allowlist auto-approve; tools off the list pause the dispatch until an operator approves, rejects, or the TTL expires.

**Architecture:** New `permission_requests` table (separate from `handoffs` to keep schemas pure). Worker callback short-circuits on `trust_mode='all'` or allowlist match; otherwise creates a row via `POST /permissions` and waits on a dedicated `GET /permissions/events` SSE channel. Operator resolves via three new MCP tools (`permission_list_pending`, `permission_get`, `permission_approve`). TTL sweeper (interval) catches dropped per-row timers from daemon restarts.

**Tech Stack:** TypeScript, bun:sqlite (existing migration pattern via `addColumnIfMissing` + `CREATE TABLE IF NOT EXISTS`), bun:test (vitest API for adapters), zod for schemas, picomatch for glob allowlist matching, `@modelcontextprotocol/sdk` for MCP tool registration. Spec: `docs/superpowers/specs/2026-04-28-phase-1c-v2-handoff-approve-design.md` (commit 5661bec).

**Critical reading before starting:**
- The v2 design doc (above).
- `packages/agentchat/src/adapters/stdio-acp.ts:91-135` — current v1 callback consumption (we extend, don't replace).
- `packages/core/src/writers/handoff.ts` and `packages/core/src/readers/handoff.ts` — the prototype for the new `permission` writer/reader.
- `packages/daemon/src/routes/handoffs.ts` and `packages/daemon/src/routes/handoffs-events.ts` — the prototypes for the four new daemon routes + SSE channel.
- `packages/mcp/src/tools/handoff-get.ts` and `packages/mcp/src/server.ts:30-164` — the prototype for the three new MCP tools + their registration.

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/core/src/schemas/event.ts` | Extend `EventTypeSchema` with three `permission-*` types |
| Create | `packages/core/src/schemas/permission.ts` | Zod schemas for permission rows + create/decide requests |
| Modify | `packages/core/src/db/schema.ts` | New `permission_requests` table + indexes |
| Create | `packages/core/src/writers/permission.ts` | Insert + atomic CAS for decide/expire |
| Create | `packages/core/src/readers/permission.ts` | get + listByStatus |
| Modify | `packages/core/src/services.ts` | Register permission writer + reader + event bus |
| Modify | `packages/core/src/index.ts` | Export new types/classes |
| Create | `packages/core/src/events/permission-events.ts` | In-process event emitter + ring buffer for SSE replay |
| Create | `packages/daemon/src/routes/permissions.ts` | Four HTTP routes (create/get/list/decide) |
| Create | `packages/daemon/src/routes/permissions-events.ts` | SSE channel route |
| Create | `packages/daemon/src/sweepers/permission-ttl.ts` | Interval sweeper for stale pending rows |
| Modify | `packages/daemon/src/serve.ts` | Register routes + start TTL sweeper |
| Modify | `packages/agentchat/src/penumbra-client.ts` | Add permission HTTP methods (create/get/list/decide/subscribe) |
| Create | `packages/agentchat/src/worker/permission-daemon-client.ts` | SSE consumer + waiter map + register-before-POST helper |
| Modify | `packages/agentchat/src/worker/permission-callback.ts` | Extend v1 factory with daemon-aware v2 form |
| Create | `packages/agentchat/src/worker/allowlist-matcher.ts` | Pure matcher (exact ∪ glob via picomatch + per-dispatch cache) |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` | Boot daemon client; per-dispatch resolve allowlist+ttl; pass v2 callback |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | Tool-name extraction guard (cancel locally if both `title` and `name` missing) |
| Modify | `packages/agentchat/src/config/types.ts` | Yaml `options.allowed_tools`, `options.permission_ttl_s` |
| Modify | `packages/agentchat/package.json` | Add `picomatch` direct dep if not present |
| Create | `packages/mcp/src/tools/permission-list-pending.ts` | MCP tool wrapper |
| Create | `packages/mcp/src/tools/permission-get.ts` | MCP tool wrapper |
| Create | `packages/mcp/src/tools/permission-approve.ts` | MCP tool wrapper |
| Modify | `packages/mcp/src/daemon-client.ts` | Add `listPermissions`/`getPermission`/`approvePermission` methods |
| Modify | `packages/mcp/src/server.ts` | Register three new tools |
| Create | tests in `packages/core/test/`, `packages/daemon/test/routes/`, `packages/agentchat/test/worker/`, `packages/agentchat/test/adapters/`, `packages/mcp/test/tools/` per task |

---

## Task 1: Permission zod schemas

**Files:**
- Create: `packages/core/src/schemas/permission.ts`
- Test: `packages/core/test/schemas/permission.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/schemas/permission.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  PermissionStatusSchema,
  PermissionRequestRowSchema,
  CreatePermissionRequestSchema,
  ApprovePermissionRequestSchema,
} from '../../src/schemas/permission.js';

describe('PermissionStatusSchema', () => {
  it('accepts the four lifecycle states', () => {
    for (const s of ['pending', 'approved', 'rejected', 'expired'] as const) {
      expect(() => PermissionStatusSchema.parse(s)).not.toThrow();
    }
  });
  it('rejects unknown statuses', () => {
    expect(() => PermissionStatusSchema.parse('cancelled')).toThrow();
  });
});

describe('PermissionRequestRowSchema', () => {
  it('parses a valid pending row', () => {
    const row = {
      permission_id: 'perm-1',
      parent_handoff_id: 'h-1',
      conversation_id: 'conv-1',
      agent_name: 'claude-acp-sonnet',
      tool_name: 'fs.readTextFile',
      raw_input_json: '{"path":"src/foo.ts"}',
      status: 'pending',
      remember_scope: null,
      decision_reason: null,
      decided_by: null,
      ttl_at: '2026-04-28T12:05:00.000Z',
      created_at: '2026-04-28T12:00:00.000Z',
      decided_at: null,
    };
    expect(() => PermissionRequestRowSchema.parse(row)).not.toThrow();
  });
});

describe('CreatePermissionRequestSchema', () => {
  it('requires all non-optional fields', () => {
    const ok = {
      permission_id: 'perm-1',
      parent_handoff_id: 'h-1',
      conversation_id: 'conv-1',
      agent_name: 'claude-acp-sonnet',
      tool_name: 'fs.readTextFile',
      raw_input: { path: 'src/foo.ts' },
    };
    expect(() => CreatePermissionRequestSchema.parse(ok)).not.toThrow();
  });
  it('rejects missing permission_id', () => {
    expect(() => CreatePermissionRequestSchema.parse({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {},
    })).toThrow();
  });
  it('accepts optional ttl_seconds', () => {
    expect(() => CreatePermissionRequestSchema.parse({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 600,
    })).not.toThrow();
  });
});

describe('ApprovePermissionRequestSchema', () => {
  it('requires decision', () => {
    expect(() => ApprovePermissionRequestSchema.parse({})).toThrow();
  });
  it('accepts approve with this_dispatch remember', () => {
    expect(() => ApprovePermissionRequestSchema.parse({
      decision: 'approve', remember: 'this_dispatch',
    })).not.toThrow();
  });
  it('rejects an unknown remember scope', () => {
    expect(() => ApprovePermissionRequestSchema.parse({
      decision: 'approve', remember: 'forever',
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/schemas/permission.test.ts`

Expected: module-not-found error (`permission.ts` doesn't exist yet).

- [ ] **Step 3: Implement the schemas**

Create `packages/core/src/schemas/permission.ts`:

```ts
import { z } from 'zod';

export const PermissionStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const PermissionRememberSchema = z.enum(['this_call', 'this_dispatch']);
export type PermissionRemember = z.infer<typeof PermissionRememberSchema>;

export const PermissionRequestRowSchema = z.object({
  permission_id: z.string(),
  parent_handoff_id: z.string(),
  conversation_id: z.string(),
  agent_name: z.string(),
  tool_name: z.string(),
  raw_input_json: z.string(),
  status: PermissionStatusSchema,
  remember_scope: PermissionRememberSchema.nullable(),
  decision_reason: z.string().nullable(),
  decided_by: z.string().nullable(),
  ttl_at: z.string(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type PermissionRequestRow = z.infer<typeof PermissionRequestRowSchema>;

export const CreatePermissionRequestSchema = z.object({
  permission_id: z.string().min(1),
  parent_handoff_id: z.string().min(1),
  conversation_id: z.string().min(1),
  agent_name: z.string().min(1),
  tool_name: z.string().min(1),
  raw_input: z.unknown(),
  ttl_seconds: z.number().int().positive().optional(),
});
export type CreatePermissionRequest = z.infer<typeof CreatePermissionRequestSchema>;

export const ApprovePermissionRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  remember: PermissionRememberSchema.optional(),
  reason: z.string().optional(),
  resolved_by: z.string().min(1).optional(),
});
export type ApprovePermissionRequest = z.infer<typeof ApprovePermissionRequestSchema>;
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/core/test/schemas/permission.test.ts`

Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schemas/permission.ts packages/core/test/schemas/permission.test.ts
git commit -m "feat(core): zod schemas for permission_requests rows + create/approve requests"
```

---

## Task 2: Extend EventTypeSchema with permission audit types

**Files:**
- Modify: `packages/core/src/schemas/event.ts`
- Test: `packages/core/test/schemas/event.test.ts` (add to existing file if present, else create)

- [ ] **Step 1: Locate and inspect**

Run: `grep -n 'EventTypeSchema' packages/core/src/schemas/event.ts`

Note the current enum literal (around line 2). It currently lists 8 types ending with `'chain-terminated'`.

- [ ] **Step 2: Write the failing test**

Append to `packages/core/test/schemas/event.test.ts` (or create the file if absent):

```ts
import { describe, expect, it } from 'bun:test';
import { T0EventInputSchema } from '../../src/schemas/event.js';

describe('EventTypeSchema permission audit types', () => {
  for (const event_type of ['permission-requested', 'permission-decided', 'permission-expired'] as const) {
    it(`accepts ${event_type}`, () => {
      const input = {
        ts: '2026-04-28T12:00:00.000Z',
        source: 'mcp',
        source_detail: 'permission-audit',
        project_id: null,
        user_id: 'u',
        machine_id: 'm',
        session_id: null,
        event_type,
        lane: 'unknown',
        provider: null, model: null,
        tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
        request_id: null,
        payload_json: { permission_id: 'p-1' },
        payload_summary: 'p-1',
      };
      expect(() => T0EventInputSchema.parse(input)).not.toThrow();
    });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/core/test/schemas/event.test.ts -t "permission audit"`

Expected: 3 fail with zod enum mismatch on `event_type`.

- [ ] **Step 4: Extend the enum**

In `packages/core/src/schemas/event.ts`, change `EventTypeSchema` from:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt',
  'agent-tool-use',
  'agent-response',
  'agent-handoff',
  'user-prompt',
  'request',
  'response',
  'chain-terminated',
]);
```

to:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt',
  'agent-tool-use',
  'agent-response',
  'agent-handoff',
  'user-prompt',
  'request',
  'response',
  'chain-terminated',
  'permission-requested',
  'permission-decided',
  'permission-expired',
]);
```

(Additive only. The sqlite column is plain TEXT so no DB migration needed.)

- [ ] **Step 5: Run test to verify pass + regression**

Run: `bun test packages/core/test/schemas/`

Expected: all schema tests pass including the 3 new ones.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas/event.ts packages/core/test/schemas/event.test.ts
git commit -m "feat(core): EventTypeSchema — add permission-{requested,decided,expired} audit types"
```

---

## Task 3: SQL schema — `permission_requests` table

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Test: `packages/core/test/db/schema-permissions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/db/schema-permissions.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, loadSqliteVec } from '../../src/index.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

test('permission_requests table exists with expected columns', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const cols = db.query<{ name: string; type: string; notnull: number }, []>(
    `SELECT name, type, notnull FROM pragma_table_info('permission_requests')`,
  ).all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  for (const required of [
    'permission_id', 'parent_handoff_id', 'conversation_id',
    'agent_name', 'tool_name', 'raw_input_json',
    'status', 'remember_scope', 'decision_reason', 'decided_by',
    'ttl_at', 'created_at', 'decided_at',
  ]) {
    expect(byName[required]).toBeDefined();
  }
  expect(byName.permission_id?.type).toBe('TEXT');
  // PK column is implicitly NOT NULL in sqlite even though notnull=0 in pragma.
  expect(byName.parent_handoff_id?.notnull).toBe(1);
  expect(byName.status?.notnull).toBe(1);
  expect(byName.ttl_at?.notnull).toBe(1);
});

test('permission_requests indexes exist', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const indexes = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='permission_requests'`,
  ).all().map((r) => r.name);
  expect(indexes).toContain('idx_perm_status_conv');
  expect(indexes).toContain('idx_perm_parent');
  expect(indexes).toContain('idx_perm_ttl');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/db/schema-permissions.test.ts`

Expected: 2 fail — table doesn't exist yet.

- [ ] **Step 3: Add the table to applySchema**

In `packages/core/src/db/schema.ts`, immediately after the `recall_audit` table (around line 126), insert inside the same `db.exec(...)` template-string block (or in a new one before the COMMIT — either works):

```sql
      CREATE TABLE IF NOT EXISTS permission_requests (
        permission_id     TEXT PRIMARY KEY,
        parent_handoff_id TEXT NOT NULL,
        conversation_id   TEXT NOT NULL,
        agent_name        TEXT NOT NULL,
        tool_name         TEXT NOT NULL,
        raw_input_json    TEXT NOT NULL,
        status            TEXT NOT NULL,
        remember_scope    TEXT,
        decision_reason   TEXT,
        decided_by        TEXT,
        ttl_at            TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        decided_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_perm_status_conv ON permission_requests(status, conversation_id);
      CREATE INDEX IF NOT EXISTS idx_perm_parent      ON permission_requests(parent_handoff_id);
      CREATE INDEX IF NOT EXISTS idx_perm_ttl         ON permission_requests(status, ttl_at);
```

(Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` to match the existing additive-migration style.)

- [ ] **Step 4: Run test to verify pass + regression**

Run: `bun test packages/core/test/db/`

Expected: all DB tests pass including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/schema-permissions.test.ts
git commit -m "feat(core): add permission_requests table + 3 indexes (phase 1c v2)"
```

---

## Task 4: PermissionWriter — insert + atomic CAS

**Files:**
- Create: `packages/core/src/writers/permission.ts`
- Test: `packages/core/test/writers/permission.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/writers/permission.test.ts`:

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, loadSqliteVec } from '../../src/index.js';
import { PermissionWriter } from '../../src/writers/permission.js';
import { PermissionReader } from '../../src/readers/permission.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

describe('PermissionWriter.create', () => {
  test('inserts a pending row with derived ttl_at', () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    const r = new PermissionReader({ db });
    const row = w.create({
      permission_id: 'perm-1',
      parent_handoff_id: 'h-1',
      conversation_id: 'conv-1',
      agent_name: 'claude-acp-sonnet',
      tool_name: 'fs.readTextFile',
      raw_input: { path: 'src/foo.ts' },
      ttl_seconds: 300,
      now: new Date('2026-04-28T12:00:00.000Z'),
    });
    expect(row.status).toBe('pending');
    expect(row.ttl_at).toBe('2026-04-28T12:05:00.000Z');
    expect(row.created_at).toBe('2026-04-28T12:00:00.000Z');
    expect(row.raw_input_json).toBe('{"path":"src/foo.ts"}');
    expect(r.get('perm-1')?.status).toBe('pending');
  });

  test('is idempotent on permission_id collision (returns existing row)', () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    const first = w.create({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 300, now: new Date('2026-04-28T12:00:00.000Z'),
    });
    const second = w.create({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't-different', raw_input: { changed: true },
      ttl_seconds: 600, now: new Date('2026-04-28T13:00:00.000Z'),
    });
    expect(second).toEqual(first);
  });
});

describe('PermissionWriter.decide', () => {
  test('approves a pending row atomically', () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 300, now: new Date('2026-04-28T12:00:00.000Z'),
    });
    const decided = w.decide('perm-1', {
      decision: 'approve',
      remember: 'this_dispatch',
      decided_by: 'machine-test',
      decided_at: '2026-04-28T12:01:00.000Z',
      reason: null,
    });
    expect(decided?.status).toBe('approved');
    expect(decided?.remember_scope).toBe('this_dispatch');
    expect(decided?.decided_by).toBe('machine-test');
  });

  test('returns null when row is already terminal (no double-decide)', () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 300, now: new Date('2026-04-28T12:00:00.000Z'),
    });
    w.decide('perm-1', { decision: 'reject', decided_by: 'm', decided_at: '2026-04-28T12:01:00.000Z', reason: null });
    const second = w.decide('perm-1', { decision: 'approve', decided_by: 'm', decided_at: '2026-04-28T12:02:00.000Z', reason: null });
    expect(second).toBeNull();
  });

  test('returns null for unknown permission_id', () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    expect(w.decide('nope', { decision: 'approve', decided_by: 'm', decided_at: 't', reason: null })).toBeNull();
  });
});

describe('PermissionWriter.expirePastDue', () => {
  test('transitions only pending rows past ttl', () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: 'p-fresh', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 300, now: new Date('2026-04-28T12:00:00.000Z'),
    });
    w.create({
      permission_id: 'p-stale', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 60, now: new Date('2026-04-28T12:00:00.000Z'),
    });
    const r = new PermissionReader({ db });
    // p-fresh ttl=12:05; p-stale ttl=12:01. Sweep at 12:02 should expire only p-stale.
    const n = w.expirePastDue('2026-04-28T12:02:00.000Z');
    expect(n).toBe(1);
    expect(r.get('p-fresh')?.status).toBe('pending');
    expect(r.get('p-stale')?.status).toBe('expired');
  });

  test('is idempotent against concurrent decide()', () => {
    const db = freshDb();
    const w = new PermissionWriter({ db });
    w.create({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {},
      ttl_seconds: 60, now: new Date('2026-04-28T12:00:00.000Z'),
    });
    const decided = w.decide('perm-1', { decision: 'approve', decided_by: 'm', decided_at: '2026-04-28T12:00:30.000Z', reason: null });
    expect(decided?.status).toBe('approved');
    // Sweeper runs after the decide — should NOT flip approved → expired.
    const n = w.expirePastDue('2026-04-28T12:05:00.000Z');
    expect(n).toBe(0);
    const r = new PermissionReader({ db });
    expect(r.get('perm-1')?.status).toBe('approved');
  });
});
```

(This test imports `PermissionReader` which we write in Task 5; that's fine — bun test compiles per-file but if the import fails the test collector errors out. To unblock this, we'll write Reader stub in Task 5 immediately. For now, accept that this test won't pass standalone until Task 5 lands.)

- [ ] **Step 2: Run test (expected to fail with module-not-found)**

Run: `bun test packages/core/test/writers/permission.test.ts`

Expected: module-not-found on `../../src/writers/permission.js` (and reader). We'll fix in Step 3 + Task 5 Step 3.

- [ ] **Step 3: Implement PermissionWriter**

Create `packages/core/src/writers/permission.ts`:

```ts
import type { Database } from 'bun:sqlite';
import type {
  ApprovePermissionRequest,
  PermissionRequestRow,
} from '../schemas/permission.js';

export interface PermissionWriterOpts {
  db: Database;
}

export interface CreatePermissionInput {
  permission_id: string;
  parent_handoff_id: string;
  conversation_id: string;
  agent_name: string;
  tool_name: string;
  raw_input: unknown;
  ttl_seconds: number;
  now: Date;
}

export interface DecidePermissionInput {
  decision: 'approve' | 'reject';
  remember?: ApprovePermissionRequest['remember'];
  decided_by: string;
  decided_at: string;
  reason: string | null;
}

export class PermissionWriter {
  private readonly db: Database;
  constructor(opts: PermissionWriterOpts) { this.db = opts.db; }

  create(input: CreatePermissionInput): PermissionRequestRow {
    const created_at = input.now.toISOString();
    const ttl_at = new Date(input.now.getTime() + input.ttl_seconds * 1000).toISOString();
    const raw_input_json = JSON.stringify(input.raw_input ?? null);

    // Idempotent: if a row exists with this permission_id, return it unchanged.
    const existing = this.db
      .query<PermissionRequestRow, [string]>(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(input.permission_id);
    if (existing) return existing;

    this.db
      .query<unknown, [string, string, string, string, string, string, string, string]>(
        `INSERT INTO permission_requests
           (permission_id, parent_handoff_id, conversation_id, agent_name,
            tool_name, raw_input_json, status, ttl_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.permission_id, input.parent_handoff_id, input.conversation_id, input.agent_name,
        input.tool_name, raw_input_json, ttl_at, created_at,
      );

    const row = this.db
      .query<PermissionRequestRow, [string]>(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(input.permission_id);
    if (!row) throw new Error(`PermissionWriter.create: row vanished after insert: ${input.permission_id}`);
    return row;
  }

  /** Atomic CAS: pending → approved|rejected. Returns the row or null if not pending. */
  decide(permission_id: string, input: DecidePermissionInput): PermissionRequestRow | null {
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const updated = this.db
      .query<unknown, [string, string | null, string | null, string, string, string]>(
        `UPDATE permission_requests
            SET status=?, remember_scope=?, decision_reason=?, decided_by=?, decided_at=?
          WHERE permission_id=? AND status='pending'`,
      )
      .run(status, input.remember ?? null, input.reason, input.decided_by, input.decided_at, permission_id);
    if (updated.changes === 0) return null;
    return this.db
      .query<PermissionRequestRow, [string]>(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(permission_id);
  }

  /** Atomic CAS: all pending rows with ttl_at <= now → expired. Returns count transitioned. */
  expirePastDue(now_iso: string): number {
    const updated = this.db
      .query<unknown, [string, string]>(
        `UPDATE permission_requests
            SET status='expired', decided_at=?
          WHERE status='pending' AND ttl_at <= ?`,
      )
      .run(now_iso, now_iso);
    return updated.changes;
  }
}
```

- [ ] **Step 4: Add a placeholder PermissionReader file so the test compiles**

Create `packages/core/src/readers/permission.ts` with the minimum needed for the writer test (full implementation in Task 5):

```ts
import type { Database } from 'bun:sqlite';
import type { PermissionRequestRow } from '../schemas/permission.js';

export interface PermissionReaderOpts { db: Database }

export class PermissionReader {
  private readonly db: Database;
  constructor(opts: PermissionReaderOpts) { this.db = opts.db; }

  get(permission_id: string): PermissionRequestRow | null {
    const row = this.db
      .query<PermissionRequestRow, [string]>(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(permission_id);
    return row ?? null;
  }
}
```

(Task 5 will extend this with `listByStatus` and tests.)

- [ ] **Step 5: Run test to verify pass**

Run: `bun test packages/core/test/writers/permission.test.ts`

Expected: 7 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/writers/permission.ts packages/core/src/readers/permission.ts packages/core/test/writers/permission.test.ts
git commit -m "feat(core): PermissionWriter — create + atomic decide CAS + TTL sweep"
```

---

## Task 5: PermissionReader — get + listByStatus

**Files:**
- Modify: `packages/core/src/readers/permission.ts` (Task 4 created the stub; extend it now)
- Test: `packages/core/test/readers/permission.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/readers/permission.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, loadSqliteVec } from '../../src/index.js';
import { PermissionWriter } from '../../src/writers/permission.js';
import { PermissionReader } from '../../src/readers/permission.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

function setup() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const w = new PermissionWriter({ db });
  const r = new PermissionReader({ db });
  return { db, w, r };
}

describe('PermissionReader.listByStatus', () => {
  test('filters by single status', () => {
    const { w, r } = setup();
    const baseTs = new Date('2026-04-28T12:00:00.000Z');
    w.create({ permission_id: 'p-1', parent_handoff_id: 'h-1', conversation_id: 'c-1', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    w.create({ permission_id: 'p-2', parent_handoff_id: 'h-1', conversation_id: 'c-1', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    w.decide('p-2', { decision: 'approve', decided_by: 'm', decided_at: '2026-04-28T12:01:00.000Z', reason: null });
    expect(r.listByStatus({ statuses: ['pending'] }).map((p) => p.permission_id)).toEqual(['p-1']);
    expect(r.listByStatus({ statuses: ['approved'] }).map((p) => p.permission_id)).toEqual(['p-2']);
  });

  test('filters by multiple statuses', () => {
    const { w, r } = setup();
    const baseTs = new Date('2026-04-28T12:00:00.000Z');
    w.create({ permission_id: 'p-1', parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    w.create({ permission_id: 'p-2', parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    w.create({ permission_id: 'p-3', parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    w.decide('p-2', { decision: 'approve', decided_by: 'm', decided_at: '2026-04-28T12:01:00.000Z', reason: null });
    w.decide('p-3', { decision: 'reject', decided_by: 'm', decided_at: '2026-04-28T12:01:00.000Z', reason: null });
    const ids = r.listByStatus({ statuses: ['approved', 'rejected'] }).map((p) => p.permission_id).sort();
    expect(ids).toEqual(['p-2', 'p-3']);
  });

  test('filters by conversation_id', () => {
    const { w, r } = setup();
    const baseTs = new Date('2026-04-28T12:00:00.000Z');
    w.create({ permission_id: 'p-A', parent_handoff_id: 'h-A', conversation_id: 'conv-A', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    w.create({ permission_id: 'p-B', parent_handoff_id: 'h-B', conversation_id: 'conv-B', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    expect(r.listByStatus({ statuses: ['pending'], conversation_id: 'conv-A' }).map((p) => p.permission_id)).toEqual(['p-A']);
  });

  test('filters by parent_handoff_id', () => {
    const { w, r } = setup();
    const baseTs = new Date('2026-04-28T12:00:00.000Z');
    w.create({ permission_id: 'p-A', parent_handoff_id: 'h-A', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    w.create({ permission_id: 'p-B', parent_handoff_id: 'h-B', conversation_id: 'c', agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300, now: baseTs });
    expect(r.listByStatus({ statuses: ['pending'], parent_handoff_id: 'h-A' }).map((p) => p.permission_id)).toEqual(['p-A']);
  });

  test('throws on empty statuses array', () => {
    const { r } = setup();
    expect(() => r.listByStatus({ statuses: [] })).toThrow();
  });
});

describe('PermissionReader.get', () => {
  test('returns null for unknown id', () => {
    const { r } = setup();
    expect(r.get('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/readers/permission.test.ts`

Expected: 5 fail (listByStatus not implemented).

- [ ] **Step 3: Extend PermissionReader**

Replace `packages/core/src/readers/permission.ts` (the Task 4 stub) with the full implementation:

```ts
import type { Database } from 'bun:sqlite';
import type { PermissionRequestRow, PermissionStatus } from '../schemas/permission.js';

export interface PermissionReaderOpts { db: Database }

export class PermissionReader {
  private readonly db: Database;
  constructor(opts: PermissionReaderOpts) { this.db = opts.db; }

  get(permission_id: string): PermissionRequestRow | null {
    const row = this.db
      .query<PermissionRequestRow, [string]>(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(permission_id);
    return row ?? null;
  }

  listByStatus(opts: {
    statuses: PermissionStatus[];
    conversation_id?: string;
    parent_handoff_id?: string;
  }): PermissionRequestRow[] {
    if (opts.statuses.length === 0) {
      throw new Error('PermissionReader.listByStatus: statuses must not be empty');
    }
    const placeholders = opts.statuses.map(() => '?').join(',');
    const where: string[] = [`status IN (${placeholders})`];
    const params: string[] = [...opts.statuses];
    if (opts.conversation_id) {
      where.push('conversation_id=?');
      params.push(opts.conversation_id);
    }
    if (opts.parent_handoff_id) {
      where.push('parent_handoff_id=?');
      params.push(opts.parent_handoff_id);
    }
    const sql = `SELECT * FROM permission_requests WHERE ${where.join(' AND ')} ORDER BY created_at ASC`;
    return this.db.query<PermissionRequestRow, string[]>(sql).all(...params);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/core/test/readers/permission.test.ts`

Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/readers/permission.ts packages/core/test/readers/permission.test.ts
git commit -m "feat(core): PermissionReader — get + listByStatus with conv/parent filters"
```

---

## Task 6: PermissionEventBus — in-process emitter + ring buffer

**Files:**
- Create: `packages/core/src/events/permission-events.ts`
- Test: `packages/core/test/events/permission-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/events/permission-events.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { PermissionEventBus, type PermissionEvent } from '../../src/events/permission-events.js';

const sample = (id: string, kind: PermissionEvent['kind']): PermissionEvent => ({
  kind, permission_id: id, ts: '2026-04-28T12:00:00.000Z', payload: { permission_id: id },
});

describe('PermissionEventBus', () => {
  test('subscribe receives subsequently-emitted events', () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const seen: PermissionEvent[] = [];
    const off = bus.subscribe((evt) => seen.push(evt));
    bus.emit(sample('p-1', 'permission.created'));
    bus.emit(sample('p-1', 'permission.decided'));
    expect(seen.map((e) => e.kind)).toEqual(['permission.created', 'permission.decided']);
    off();
  });

  test('unsubscribe stops further deliveries', () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const seen: PermissionEvent[] = [];
    const off = bus.subscribe((evt) => seen.push(evt));
    off();
    bus.emit(sample('p-1', 'permission.created'));
    expect(seen).toEqual([]);
  });

  test('replaySince returns events strictly after the supplied seq', () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const a = bus.emit(sample('p-1', 'permission.created'));
    const b = bus.emit(sample('p-2', 'permission.created'));
    const c = bus.emit(sample('p-3', 'permission.created'));
    expect(bus.replaySince(a.seq).map((e) => e.permission_id)).toEqual(['p-2', 'p-3']);
    expect(bus.replaySince(c.seq)).toEqual([]);
  });

  test('replaySince returns null when seq is older than the ring buffer', () => {
    const bus = new PermissionEventBus({ ringSize: 2 });
    const stale = bus.emit(sample('p-1', 'permission.created'));
    bus.emit(sample('p-2', 'permission.created'));
    bus.emit(sample('p-3', 'permission.created'));
    bus.emit(sample('p-4', 'permission.created'));
    expect(bus.replaySince(stale.seq)).toBeNull();
  });

  test('subscriber throwing does not block other subscribers', () => {
    const bus = new PermissionEventBus({ ringSize: 8 });
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((evt) => seen.push(evt.permission_id));
    bus.emit(sample('p-1', 'permission.created'));
    expect(seen).toEqual(['p-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/events/permission-events.test.ts`

Expected: module-not-found.

- [ ] **Step 3: Implement the event bus**

Create `packages/core/src/events/permission-events.ts`:

```ts
export type PermissionEventKind = 'permission.created' | 'permission.decided' | 'permission.expired';

export interface PermissionEvent {
  kind: PermissionEventKind;
  permission_id: string;
  ts: string;
  /** Event-specific payload — same shape the SSE wire serialises. */
  payload: Record<string, unknown>;
}

export interface EmittedPermissionEvent extends PermissionEvent {
  seq: number;
}

export type PermissionEventListener = (evt: EmittedPermissionEvent) => void;

export class PermissionEventBus {
  private listeners = new Set<PermissionEventListener>();
  private ring: EmittedPermissionEvent[] = [];
  private nextSeq = 1;
  private readonly ringSize: number;

  constructor(opts: { ringSize?: number } = {}) {
    this.ringSize = opts.ringSize ?? 256;
  }

  subscribe(fn: PermissionEventListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  emit(evt: PermissionEvent): EmittedPermissionEvent {
    const stamped: EmittedPermissionEvent = { ...evt, seq: this.nextSeq++ };
    this.ring.push(stamped);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }
    for (const fn of this.listeners) {
      try { fn(stamped); } catch { /* one bad subscriber must not block others */ }
    }
    return stamped;
  }

  /**
   * Returns events with seq > sinceSeq, or null if the requested seq has
   * already fallen out of the ring buffer (caller must re-fetch state).
   */
  replaySince(sinceSeq: number): EmittedPermissionEvent[] | null {
    if (this.ring.length === 0) return [];
    const earliest = this.ring[0]!.seq;
    if (sinceSeq < earliest - 1) return null;
    return this.ring.filter((e) => e.seq > sinceSeq);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/core/test/events/permission-events.test.ts`

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/permission-events.ts packages/core/test/events/permission-events.test.ts
git commit -m "feat(core): PermissionEventBus — in-process emitter with seq + ring-buffer replay"
```

---

## Task 7: Wire writer + reader + bus into Services + exports

**Files:**
- Modify: `packages/core/src/services.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add to Services interface**

In `packages/core/src/services.ts`, find the `Services` interface and add three fields next to the handoff equivalents:

```ts
  permissionWriter: PermissionWriter;
  permissionReader: PermissionReader;
  permissionEvents: PermissionEventBus;
```

Add the imports at the top of the file:

```ts
import { PermissionWriter } from './writers/permission.js';
import { PermissionReader } from './readers/permission.js';
import { PermissionEventBus } from './events/permission-events.js';
```

- [ ] **Step 2: Wire the construction in buildServices**

Inside `buildServices`, where the existing handoff writer/reader are constructed, add:

```ts
  const permissionEvents = new PermissionEventBus();
  const permissionWriter = new PermissionWriter({ db: opts.db });
  const permissionReader = new PermissionReader({ db: opts.db });
```

And include them in the returned `Services` object alongside the handoff equivalents.

- [ ] **Step 3: Export from packages/core/src/index.ts**

Add to `packages/core/src/index.ts`:

```ts
export {
  PermissionStatusSchema,
  PermissionRememberSchema,
  PermissionRequestRowSchema,
  CreatePermissionRequestSchema,
  ApprovePermissionRequestSchema,
  type PermissionStatus,
  type PermissionRemember,
  type PermissionRequestRow,
  type CreatePermissionRequest,
  type ApprovePermissionRequest,
} from './schemas/permission.js';
export {
  PermissionWriter,
  type PermissionWriterOpts,
  type CreatePermissionInput,
  type DecidePermissionInput,
} from './writers/permission.js';
export { PermissionReader, type PermissionReaderOpts } from './readers/permission.js';
export {
  PermissionEventBus,
  type PermissionEvent,
  type EmittedPermissionEvent,
  type PermissionEventKind,
  type PermissionEventListener,
} from './events/permission-events.js';
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`

Expected: exit 0. (If a typecheck error mentions a missing field on `Services`, find any test helper that constructs a partial `Services` and ensure those tests cast via `as unknown as Services` — they're stubs so missing fields are fine.)

- [ ] **Step 5: Run the full core test suite to verify no regression**

Run: `bun test packages/core/`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services.ts packages/core/src/index.ts
git commit -m "feat(core): wire PermissionWriter/Reader/EventBus into Services + exports"
```

---

## Task 8: Daemon HTTP routes — `POST /permissions` (create)

**Files:**
- Create: `packages/daemon/src/routes/permissions.ts`
- Test: `packages/daemon/test/routes/permissions-create.test.ts`

We split the four routes across Tasks 8–11 for review-friendly diffs. All four end up in the same file.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/permissions-create.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services, migrate, loadSqliteVec,
  PermissionWriter, PermissionReader, PermissionEventBus,
} from '@penumbra/core';
import { permissionsCreateRoute } from '../../src/routes/permissions.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* loaded */ }

function makeServices(db: Database): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => 'machine-test' },
    uuid: () => 'uuid-not-used',  // route uses client-supplied permission_id
    clock: () => new Date('2026-04-28T12:00:00.000Z'),
    t0Writer: { write: () => {} },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

test('POST /permissions creates a pending row', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const req = new Request('http://x/permissions', {
    method: 'POST',
    body: JSON.stringify({
      permission_id: 'perm-1',
      parent_handoff_id: 'h-1',
      conversation_id: 'conv-1',
      agent_name: 'claude-acp-sonnet',
      tool_name: 'fs.readTextFile',
      raw_input: { path: 'src/foo.ts' },
      ttl_seconds: 300,
    }),
  });
  const res = await permissionsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.permission_id).toBe('perm-1');
  expect(body.status).toBe('pending');
  expect(body.ttl_at).toBe('2026-04-28T12:05:00.000Z');
});

test('POST /permissions emits permission.created on the event bus', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const seen: string[] = [];
  services.permissionEvents.subscribe((evt) => seen.push(evt.kind));

  const req = new Request('http://x/permissions', {
    method: 'POST',
    body: JSON.stringify({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 60,
    }),
  });
  await permissionsCreateRoute(req, services);
  expect(seen).toEqual(['permission.created']);
});

test('POST /permissions is idempotent on permission_id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const body = JSON.stringify({
    permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
    agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300,
  });
  const r1 = await permissionsCreateRoute(new Request('http://x/permissions', { method: 'POST', body }), services);
  const r2 = await permissionsCreateRoute(new Request('http://x/permissions', { method: 'POST', body }), services);
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  expect((await r2.json()).status).toBe('pending');
});

test('POST /permissions returns 400 for invalid body', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const req = new Request('http://x/permissions', { method: 'POST', body: JSON.stringify({}) });
  const res = await permissionsCreateRoute(req, services);
  expect(res.status).toBe(400);
});

test('POST /permissions defaults ttl_seconds from settings', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const req = new Request('http://x/permissions', {
    method: 'POST',
    body: JSON.stringify({
      permission_id: 'perm-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {},
    }),
  });
  const res = await permissionsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  // 12:00:00 + 300s = 12:05:00
  expect(body.ttl_at).toBe('2026-04-28T12:05:00.000Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/routes/permissions-create.test.ts`

Expected: module-not-found.

- [ ] **Step 3: Implement the route**

Create `packages/daemon/src/routes/permissions.ts`:

```ts
import type { Services } from '@penumbra/core';
import { CreatePermissionRequestSchema } from '@penumbra/core';

const DEFAULT_TTL_SECONDS = 300;

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function permissionsCreateRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const parsed = CreatePermissionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const ttl_seconds = parsed.data.ttl_seconds
    ?? Number((services.settings as any)?.permission_ttl_seconds ?? DEFAULT_TTL_SECONDS);
  const now = services.clock();

  const row = services.permissionWriter.create({
    permission_id: parsed.data.permission_id,
    parent_handoff_id: parsed.data.parent_handoff_id,
    conversation_id: parsed.data.conversation_id,
    agent_name: parsed.data.agent_name,
    tool_name: parsed.data.tool_name,
    raw_input: parsed.data.raw_input,
    ttl_seconds,
    now,
  });

  // Audit + bus emission only when this call genuinely created the row
  // (idempotent re-POST returns the existing row unchanged — no event fanned out).
  const isFreshCreate = row.created_at === now.toISOString();
  if (isFreshCreate) {
    services.permissionEvents.emit({
      kind: 'permission.created',
      permission_id: row.permission_id,
      ts: row.created_at,
      payload: {
        permission_id: row.permission_id,
        parent_handoff_id: row.parent_handoff_id,
        conversation_id: row.conversation_id,
        agent_name: row.agent_name,
        tool_name: row.tool_name,
        ttl_at: row.ttl_at,
        created_at: row.created_at,
      },
    });
    services.t0Writer.write({
      event_id: services.uuid(),
      ts: row.created_at,
      ingest_ts: row.created_at,
      source: 'mcp',
      source_detail: 'permission-audit',
      project_id: null,
      user_id: services.machineId.get(),
      machine_id: services.machineId.get(),
      session_id: row.conversation_id,
      event_type: 'permission-requested',
      lane: 'unknown',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: {
        permission_id: row.permission_id,
        parent_handoff_id: row.parent_handoff_id,
        agent_name: row.agent_name,
        tool_name: row.tool_name,
        raw_input: JSON.parse(row.raw_input_json),
      },
      payload_summary: `${row.agent_name} requested ${row.tool_name}`,
    });
  }

  return json({
    permission_id: row.permission_id,
    status: row.status,
    ttl_at: row.ttl_at,
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/daemon/test/routes/permissions-create.test.ts`

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/permissions.ts packages/daemon/test/routes/permissions-create.test.ts
git commit -m "feat(daemon): POST /permissions — create + emit + audit (idempotent on permission_id)"
```

---

## Task 9: Daemon HTTP routes — GET single + GET list

**Files:**
- Modify: `packages/daemon/src/routes/permissions.ts`
- Test: `packages/daemon/test/routes/permissions-read.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/permissions-read.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services, migrate, loadSqliteVec,
  PermissionWriter, PermissionReader, PermissionEventBus,
} from '@penumbra/core';
import {
  permissionsCreateRoute,
  permissionsGetRoute,
  permissionsListRoute,
} from '../../src/routes/permissions.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function makeServices(db: Database): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => 'machine-test' }, uuid: () => 'evt-1',
    clock: () => new Date('2026-04-28T12:00:00.000Z'),
    t0Writer: { write: () => {} },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

async function seed(services: Services, permission_id: string, conversation_id = 'c-1', parent_handoff_id = 'h-1') {
  await permissionsCreateRoute(new Request('http://x/permissions', {
    method: 'POST',
    body: JSON.stringify({
      permission_id, parent_handoff_id, conversation_id,
      agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 300,
    }),
  }), services);
}

test('GET /permissions/:id returns the row', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, 'perm-1');
  const res = await permissionsGetRoute(new Request('http://x/permissions/perm-1'), 'perm-1', services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.permission.permission_id).toBe('perm-1');
  expect(body.permission.status).toBe('pending');
});

test('GET /permissions/:id returns 404 for unknown', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await permissionsGetRoute(new Request('http://x/permissions/nope'), 'nope', services);
  expect(res.status).toBe(404);
});

test('GET /permissions filters by status (default pending)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, 'perm-1');
  await seed(services, 'perm-2');
  const res = await permissionsListRoute(new Request('http://x/permissions'), services);
  const body = await res.json();
  expect(body.permissions.map((p: any) => p.permission_id).sort()).toEqual(['perm-1', 'perm-2']);
});

test('GET /permissions filters by conversation_id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, 'perm-A', 'conv-A');
  await seed(services, 'perm-B', 'conv-B');
  const res = await permissionsListRoute(
    new Request('http://x/permissions?conversation_id=conv-A'),
    services,
  );
  const body = await res.json();
  expect(body.permissions.map((p: any) => p.permission_id)).toEqual(['perm-A']);
});

test('GET /permissions filters by parent_handoff_id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, 'perm-A', 'c', 'h-A');
  await seed(services, 'perm-B', 'c', 'h-B');
  const res = await permissionsListRoute(
    new Request('http://x/permissions?parent_handoff_id=h-A'),
    services,
  );
  const body = await res.json();
  expect(body.permissions.map((p: any) => p.permission_id)).toEqual(['perm-A']);
});

test('GET /permissions accepts comma-separated status list', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seed(services, 'perm-1');
  // Force perm-1 to approved by going through writer directly.
  services.permissionWriter.decide('perm-1', { decision: 'approve', decided_by: 'm', decided_at: '2026-04-28T12:01:00.000Z', reason: null });
  await seed(services, 'perm-2');
  const res = await permissionsListRoute(new Request('http://x/permissions?status=pending,approved'), services);
  const body = await res.json();
  expect(body.permissions.map((p: any) => p.permission_id).sort()).toEqual(['perm-1', 'perm-2']);
});

test('GET /permissions returns 400 for unknown status', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await permissionsListRoute(new Request('http://x/permissions?status=cancelled'), services);
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/routes/permissions-read.test.ts`

Expected: 7 fail (routes not exported yet).

- [ ] **Step 3: Add the routes**

Append to `packages/daemon/src/routes/permissions.ts`:

```ts
import { PermissionStatusSchema } from '@penumbra/core';

const VALID_STATUSES = new Set<string>(PermissionStatusSchema.options);

export async function permissionsGetRoute(_req: Request, permission_id: string, services: Services): Promise<Response> {
  const row = services.permissionReader.get(permission_id);
  if (!row) {
    return json({ error: { code: 'not_found', message: `permission ${permission_id} not found` } }, 404);
  }
  return json({ permission: row });
}

export async function permissionsListRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conv = url.searchParams.get('conversation_id') ?? undefined;
  const parent = url.searchParams.get('parent_handoff_id') ?? undefined;
  const statusParam = url.searchParams.get('status');

  let statuses: string[];
  if (statusParam !== null) {
    statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 0) {
      return json({ error: { code: 'validation_error', message: 'status is empty' } }, 400);
    }
    for (const s of statuses) {
      if (!VALID_STATUSES.has(s)) {
        return json({ error: { code: 'validation_error', message: `unknown status: ${s}` } }, 400);
      }
    }
  } else {
    statuses = ['pending'];
  }

  const permissions = services.permissionReader.listByStatus({
    statuses: statuses as any,
    conversation_id: conv,
    parent_handoff_id: parent,
  });
  return json({ permissions });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/daemon/test/routes/permissions-read.test.ts`

Expected: 7 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/permissions.ts packages/daemon/test/routes/permissions-read.test.ts
git commit -m "feat(daemon): GET /permissions/:id + GET /permissions (with status/conv/parent filters)"
```

---

## Task 10: Daemon HTTP route — POST decide

**Files:**
- Modify: `packages/daemon/src/routes/permissions.ts`
- Test: `packages/daemon/test/routes/permissions-decide.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/permissions-decide.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services, migrate, loadSqliteVec,
  PermissionWriter, PermissionReader, PermissionEventBus,
} from '@penumbra/core';
import {
  permissionsCreateRoute,
  permissionsDecideRoute,
} from '../../src/routes/permissions.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function makeServices(db: Database): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => 'machine-test' }, uuid: () => 'evt-1',
    clock: () => new Date('2026-04-28T12:01:00.000Z'),
    t0Writer: { write: () => {} },
    settings: { permission_ttl_seconds: 300 },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

async function seedPending(services: Services, id = 'perm-1') {
  await permissionsCreateRoute(new Request('http://x/permissions', {
    method: 'POST',
    body: JSON.stringify({
      permission_id: id, parent_handoff_id: 'h-1', conversation_id: 'c-1',
      agent_name: 'a', tool_name: 't', raw_input: { path: 'src/foo.ts' }, ttl_seconds: 300,
    }),
  }), services);
}

test('POST /permissions/:id/decide approves a pending row', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);

  const res = await permissionsDecideRoute(
    new Request('http://x/permissions/perm-1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', remember: 'this_dispatch' }),
    }),
    'perm-1', services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('approved');
  expect(services.permissionReader.get('perm-1')?.remember_scope).toBe('this_dispatch');
});

test('POST /permissions/:id/decide emits permission.decided', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);
  const seen: any[] = [];
  services.permissionEvents.subscribe((e) => seen.push(e));

  await permissionsDecideRoute(
    new Request('http://x/permissions/perm-1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject', reason: 'no third-party calls' }),
    }),
    'perm-1', services,
  );
  expect(seen.map((e) => e.kind)).toEqual(['permission.decided']);
  expect(seen[0].payload.decision).toBe('reject');
  expect(seen[0].payload.reason).toBe('no third-party calls');
});

test('POST /permissions/:id/decide returns 409 if already terminal', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);
  // First decision succeeds.
  await permissionsDecideRoute(
    new Request('http://x/permissions/perm-1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    }),
    'perm-1', services,
  );
  // Second decision conflicts.
  const res = await permissionsDecideRoute(
    new Request('http://x/permissions/perm-1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject' }),
    }),
    'perm-1', services,
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.current_status).toBe('approved');
});

test('POST /permissions/:id/decide returns 404 for unknown id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await permissionsDecideRoute(
    new Request('http://x/permissions/nope/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    }),
    'nope', services,
  );
  expect(res.status).toBe(404);
});

test('POST /permissions/:id/decide returns 400 for invalid body', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await seedPending(services);
  const res = await permissionsDecideRoute(
    new Request('http://x/permissions/perm-1/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'maybe' }),
    }),
    'perm-1', services,
  );
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/routes/permissions-decide.test.ts`

Expected: 5 fail (route not exported).

- [ ] **Step 3: Implement the route**

Append to `packages/daemon/src/routes/permissions.ts`:

```ts
import { ApprovePermissionRequestSchema } from '@penumbra/core';

export async function permissionsDecideRoute(
  req: Request, permission_id: string, services: Services,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const parsed = ApprovePermissionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const decided_at = services.clock().toISOString();
  const decided_by = parsed.data.resolved_by ?? services.machineId.get();

  const row = services.permissionWriter.decide(permission_id, {
    decision: parsed.data.decision,
    remember: parsed.data.remember,
    decided_by,
    decided_at,
    reason: parsed.data.reason ?? null,
  });

  if (!row) {
    const cur = services.permissionReader.get(permission_id);
    if (!cur) {
      return json({ error: { code: 'not_found', message: `permission ${permission_id} does not exist` } }, 404);
    }
    return json({
      error: { code: 'conflict', message: `permission ${permission_id} is ${cur.status}, not pending` },
      current_status: cur.status,
    }, 409);
  }

  services.permissionEvents.emit({
    kind: 'permission.decided',
    permission_id: row.permission_id,
    ts: decided_at,
    payload: {
      permission_id: row.permission_id,
      decision: parsed.data.decision,
      remember: parsed.data.remember ?? null,
      decided_by,
      decided_at,
      reason: parsed.data.reason ?? null,
    },
  });

  services.t0Writer.write({
    event_id: services.uuid(),
    ts: decided_at,
    ingest_ts: decided_at,
    source: 'mcp',
    source_detail: 'permission-audit',
    project_id: null,
    user_id: services.machineId.get(),
    machine_id: services.machineId.get(),
    session_id: row.conversation_id,
    event_type: 'permission-decided',
    lane: 'unknown',
    provider: null, model: null,
    tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
    request_id: null,
    payload_json: {
      permission_id: row.permission_id,
      tool_name: row.tool_name,
      decision: parsed.data.decision,
      remember: parsed.data.remember ?? null,
      decided_by,
      reason: parsed.data.reason ?? null,
    },
    payload_summary: `${parsed.data.decision} ${row.tool_name}`,
  });

  return json({
    permission_id: row.permission_id,
    status: row.status,
    decided_at,
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/daemon/test/routes/permissions-decide.test.ts`

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/permissions.ts packages/daemon/test/routes/permissions-decide.test.ts
git commit -m "feat(daemon): POST /permissions/:id/decide — atomic CAS + event emission + audit"
```

---

## Task 11: Daemon SSE route — `GET /permissions/events`

**Files:**
- Create: `packages/daemon/src/routes/permissions-events.ts`
- Test: `packages/daemon/test/routes/permissions-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/routes/permissions-events.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { PermissionEventBus, type Services } from '@penumbra/core';
import { permissionsEventsRoute } from '../../src/routes/permissions-events.js';

function makeServices(): Services {
  return {
    permissionEvents: new PermissionEventBus(),
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

async function readChunks(stream: ReadableStream<Uint8Array>, max: number): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  const td = new TextDecoder();
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(td.decode(value));
  }
  reader.releaseLock();
  return out;
}

test('GET /permissions/events streams emitted events as SSE', async () => {
  const services = makeServices();
  const res = await permissionsEventsRoute(new Request('http://x/permissions/events'), services);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');

  // Emit and read in parallel
  const chunkPromise = readChunks(res.body!, 2);
  setTimeout(() => {
    services.permissionEvents.emit({
      kind: 'permission.created',
      permission_id: 'perm-1',
      ts: '2026-04-28T12:00:00.000Z',
      payload: { permission_id: 'perm-1' },
    });
  }, 5);
  const chunks = await chunkPromise;
  // First chunk should contain the initial ': ok' comment.
  expect(chunks[0]).toContain(': ok');
  // The next chunk should carry the emitted event.
  expect(chunks.join('')).toContain('event: permission.created');
  expect(chunks.join('')).toContain('"permission_id":"perm-1"');
  expect(chunks.join('')).toContain('id: perm-1:');
});

test('GET /permissions/events with Last-Event-ID replays missed events from ring buffer', async () => {
  const services = makeServices();
  // Pre-emit two events.
  const a = services.permissionEvents.emit({
    kind: 'permission.created', permission_id: 'p-1', ts: 't', payload: {},
  });
  services.permissionEvents.emit({
    kind: 'permission.created', permission_id: 'p-2', ts: 't', payload: {},
  });

  const res = await permissionsEventsRoute(
    new Request('http://x/permissions/events', { headers: { 'last-event-id': `seq:${a.seq}` } }),
    services,
  );
  expect(res.status).toBe(200);
  // Read enough chunks to capture the replayed event(s).
  const chunks = await readChunks(res.body!, 2);
  const text = chunks.join('');
  // Should contain p-2 (after a.seq) but not p-1.
  expect(text).toContain('"permission_id":"p-2"');
  expect(text).not.toContain('"permission_id":"p-1"');
});

test('Last-Event-ID older than ring buffer signals client to resync (no replay)', async () => {
  const services = makeServices();
  // Use a tiny ring to force eviction.
  (services as any).permissionEvents = new PermissionEventBus({ ringSize: 2 });
  const stale = (services as any).permissionEvents.emit({ kind: 'permission.created', permission_id: 'p-1', ts: 't', payload: {} });
  for (const id of ['p-2', 'p-3', 'p-4']) {
    (services as any).permissionEvents.emit({ kind: 'permission.created', permission_id: id, ts: 't', payload: {} });
  }
  const res = await permissionsEventsRoute(
    new Request('http://x/permissions/events', { headers: { 'last-event-id': `seq:${stale.seq}` } }),
    services,
  );
  // Read until we see the resync hint.
  const chunks = await readChunks(res.body!, 1);
  expect(chunks.join('')).toContain(': resync');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/routes/permissions-events.test.ts`

Expected: module-not-found.

- [ ] **Step 3: Implement the SSE route**

Create `packages/daemon/src/routes/permissions-events.ts`:

```ts
import type { Services } from '@penumbra/core';
import type { EmittedPermissionEvent } from '@penumbra/core';

function formatSse(evt: EmittedPermissionEvent): string {
  return `event: ${evt.kind}\nid: ${evt.permission_id}:${evt.seq}\ndata: ${JSON.stringify(evt.payload)}\n\n`;
}

function parseLastEventSeq(header: string | null): number | null {
  if (!header) return null;
  // Format: "seq:<n>" — uses a prefix so future event-id schemes can co-exist.
  const m = /^seq:(\d+)$/.exec(header);
  if (!m) return null;
  return Number(m[1]);
}

export async function permissionsEventsRoute(req: Request, services: Services): Promise<Response> {
  let off: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const lastSeq = parseLastEventSeq(req.headers.get('last-event-id'));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      // Replay missed events first if Last-Event-ID was supplied.
      if (lastSeq !== null) {
        const replay = services.permissionEvents.replaySince(lastSeq);
        if (replay === null) {
          // Ring buffer evicted — signal client to resync via per-id GET.
          controller.enqueue(encoder.encode(': resync\n\n'));
        } else {
          for (const evt of replay) {
            controller.enqueue(encoder.encode(formatSse(evt)));
          }
        }
      } else {
        controller.enqueue(encoder.encode(': ok\n\n'));
      }

      off = services.permissionEvents.subscribe((evt) => {
        try {
          controller.enqueue(encoder.encode(formatSse(evt)));
        } catch {
          off?.();
          off = null;
          if (keepalive) clearInterval(keepalive);
          keepalive = null;
        }
      });

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          off?.();
          off = null;
          if (keepalive) clearInterval(keepalive);
          keepalive = null;
        }
      }, 15_000);
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      try { off?.(); } catch { /* noop */ }
      off = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/daemon/test/routes/permissions-events.test.ts`

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/permissions-events.ts packages/daemon/test/routes/permissions-events.test.ts
git commit -m "feat(daemon): GET /permissions/events — SSE channel with Last-Event-ID replay"
```

---

## Task 12: TTL sweeper

**Files:**
- Create: `packages/daemon/src/sweepers/permission-ttl.ts`
- Test: `packages/daemon/test/sweepers/permission-ttl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/test/sweepers/permission-ttl.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  type Services, migrate, loadSqliteVec,
  PermissionWriter, PermissionReader, PermissionEventBus,
} from '@penumbra/core';
import { runPermissionTtlSweep } from '../../src/sweepers/permission-ttl.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function makeServices(db: Database, now: Date): Services {
  return {
    db,
    permissionWriter: new PermissionWriter({ db }),
    permissionReader: new PermissionReader({ db }),
    permissionEvents: new PermissionEventBus(),
    machineId: { get: () => 'machine-test' }, uuid: (() => { let n = 0; return () => `evt-${++n}`; })(),
    clock: () => now,
    t0Writer: { write: () => {} },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

test('runPermissionTtlSweep transitions stale rows to expired and emits events', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, new Date('2026-04-28T12:02:00.000Z'));

  const baseTs = new Date('2026-04-28T12:00:00.000Z');
  services.permissionWriter.create({
    permission_id: 'p-stale', parent_handoff_id: 'h-1', conversation_id: 'c',
    agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 60, now: baseTs,
  });
  services.permissionWriter.create({
    permission_id: 'p-fresh', parent_handoff_id: 'h-1', conversation_id: 'c',
    agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 600, now: baseTs,
  });
  const seen: any[] = [];
  services.permissionEvents.subscribe((e) => seen.push(e));

  const n = runPermissionTtlSweep(services);
  expect(n).toBe(1);
  expect(services.permissionReader.get('p-stale')?.status).toBe('expired');
  expect(services.permissionReader.get('p-fresh')?.status).toBe('pending');
  expect(seen.map((e) => e.kind)).toEqual(['permission.expired']);
  expect(seen[0].permission_id).toBe('p-stale');
});

test('runPermissionTtlSweep is idempotent on subsequent calls', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db); migrate(db, { embeddingDim: 384 });
  const services = makeServices(db, new Date('2026-04-28T12:02:00.000Z'));

  services.permissionWriter.create({
    permission_id: 'p-stale', parent_handoff_id: 'h-1', conversation_id: 'c',
    agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 60, now: new Date('2026-04-28T12:00:00.000Z'),
  });
  expect(runPermissionTtlSweep(services)).toBe(1);
  expect(runPermissionTtlSweep(services)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/test/sweepers/permission-ttl.test.ts`

Expected: module-not-found.

- [ ] **Step 3: Implement the sweeper**

Create `packages/daemon/src/sweepers/permission-ttl.ts`:

```ts
import type { Services } from '@penumbra/core';

/**
 * Atomic CAS sweep: pending rows whose ttl_at <= now → expired. Emits one
 * permission.expired event per transitioned row + writes a t0 audit event.
 * Returns the count of rows transitioned.
 *
 * Idempotent — concurrent calls compete via SQL UPDATE WHERE; only one wins
 * each row. Safe to run alongside per-row setTimeout TTL fires (also CAS).
 */
export function runPermissionTtlSweep(services: Services): number {
  const now_iso = services.clock().toISOString();
  // Snapshot the candidates BEFORE the UPDATE so we know which ids transitioned.
  const candidates = services.permissionReader.listByStatus({ statuses: ['pending'] })
    .filter((row) => row.ttl_at <= now_iso);
  if (candidates.length === 0) return 0;

  const transitioned = services.permissionWriter.expirePastDue(now_iso);
  if (transitioned === 0) return 0;

  // Re-read the rows we attempted to expire; only emit for ones now 'expired'.
  for (const candidate of candidates) {
    const row = services.permissionReader.get(candidate.permission_id);
    if (!row || row.status !== 'expired') continue;
    services.permissionEvents.emit({
      kind: 'permission.expired',
      permission_id: row.permission_id,
      ts: now_iso,
      payload: {
        permission_id: row.permission_id,
        ttl_at: row.ttl_at,
        expired_at: now_iso,
      },
    });
    services.t0Writer.write({
      event_id: services.uuid(),
      ts: now_iso,
      ingest_ts: now_iso,
      source: 'mcp',
      source_detail: 'permission-audit',
      project_id: null,
      user_id: services.machineId.get(),
      machine_id: services.machineId.get(),
      session_id: row.conversation_id,
      event_type: 'permission-expired',
      lane: 'unknown',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: { permission_id: row.permission_id, ttl_at: row.ttl_at },
      payload_summary: `permission ${row.permission_id} expired`,
    });
  }
  return transitioned;
}

/** Schedules the sweep on a recurring interval. Returns a cancel function. */
export function startPermissionTtlSweeper(services: Services, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    try { runPermissionTtlSweep(services); }
    catch (err) { (services as any).log?.warn?.({ err: String(err) }, 'permission-ttl sweep failed'); }
  }, intervalMs);
  // Don't keep the process alive just for this timer.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/daemon/test/sweepers/permission-ttl.test.ts`

Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/sweepers/permission-ttl.ts packages/daemon/test/sweepers/permission-ttl.test.ts
git commit -m "feat(daemon): permission TTL sweeper — interval CAS expire + audit/event emission"
```

---

## Task 13: Wire daemon routes + sweeper into serve.ts

**Files:**
- Modify: `packages/daemon/src/serve.ts`

- [ ] **Step 1: Add route imports**

In `packages/daemon/src/serve.ts`, add these imports near the existing route imports:

```ts
import {
  permissionsCreateRoute,
  permissionsGetRoute,
  permissionsListRoute,
  permissionsDecideRoute,
} from './routes/permissions.js';
import { permissionsEventsRoute } from './routes/permissions-events.js';
import { startPermissionTtlSweeper } from './sweepers/permission-ttl.js';
```

- [ ] **Step 2: Register routes in the request handler**

In the request handler function (the one with the `if (req.method === 'POST' && url.pathname === '/handoffs')` chain), add — placed near the handoffs routes for locality:

```ts
    if (req.method === 'POST' && url.pathname === '/permissions') {
      return permissionsCreateRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/permissions') {
      return permissionsListRoute(req, opts.services);
    }
    if (req.method === 'GET' && url.pathname === '/permissions/events') {
      return permissionsEventsRoute(req, opts.services);
    }
    const permissionGetMatch = url.pathname.match(/^\/permissions\/([^/]+)$/);
    if (permissionGetMatch && req.method === 'GET') {
      return permissionsGetRoute(req, permissionGetMatch[1]!, opts.services);
    }
    const permissionDecideMatch = url.pathname.match(/^\/permissions\/([^/]+)\/decide$/);
    if (permissionDecideMatch && req.method === 'POST') {
      return permissionsDecideRoute(req, permissionDecideMatch[1]!, opts.services);
    }
```

(Order matters: register `GET /permissions/events` BEFORE the `GET /permissions/:id` regex, because `events` would otherwise match the regex and route the wrong way.)

- [ ] **Step 3: Start the TTL sweeper at boot**

Find where the server starts (after the `serve(...)` call or in the top-level setup of `serve.ts`). Add:

```ts
  const stopPermissionSweeper = startPermissionTtlSweeper(opts.services);
```

If `serve.ts` returns a cleanup function (or a stop handle), add `stopPermissionSweeper()` to it. If not, the unref'd interval just dies with the process — acceptable.

- [ ] **Step 4: Typecheck + run full daemon test suite**

Run:
```bash
bun run typecheck
bun test packages/daemon/
```

Expected: typecheck exit 0; all daemon tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/serve.ts
git commit -m "feat(daemon): register /permissions routes + boot TTL sweeper"
```

---

## Task 14: PenumbraClient permission methods (worker-side HTTP)

**Files:**
- Modify: `packages/agentchat/src/penumbra-client.ts`
- Test: `packages/agentchat/test/penumbra-client.test.ts` (extend existing if present, else create minimal)

- [ ] **Step 1: Inspect the existing client**

Run: `grep -n 'class PenumbraClient\|async \w*Handoff\|baseUrl\|fetch(' packages/agentchat/src/penumbra-client.ts | head -20`

Note the existing pattern — methods are typed wrappers over `fetch(${baseUrl}/...)` returning JSON. Match that style exactly.

- [ ] **Step 2: Write the failing test**

Create or extend `packages/agentchat/test/penumbra-client.test.ts` with three test cases for the new methods. The test uses a mocked `fetch` (or a simple in-process server stub):

```ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { PenumbraClient } from '../src/penumbra-client.js';

const calls: { url: string; init: RequestInit | undefined }[] = [];
const responses: Response[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0; responses.length = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return r;
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; });

function makeClient() {
  // Use the same constructor signature the worker uses; fetch is global.
  return new PenumbraClient({ storageRoot: '/tmp/test-storage', baseUrl: 'http://daemon.test' } as any);
}

describe('PenumbraClient permission methods', () => {
  test('createPermission posts the body and returns the response', async () => {
    responses.push(new Response(JSON.stringify({ permission_id: 'p-1', status: 'pending', ttl_at: 't' }), { status: 200 }));
    const client = makeClient();
    const out = await client.createPermission({
      permission_id: 'p-1', parent_handoff_id: 'h-1', conversation_id: 'c',
      agent_name: 'a', tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });
    expect(out).toEqual({ permission_id: 'p-1', status: 'pending', ttl_at: 't' });
    expect(calls[0].url).toBe('http://daemon.test/permissions');
    expect(calls[0].init?.method).toBe('POST');
  });

  test('getPermission fetches and returns the row', async () => {
    responses.push(new Response(JSON.stringify({ permission: { permission_id: 'p-1' } }), { status: 200 }));
    const client = makeClient();
    const out = await client.getPermission('p-1');
    expect(out.permission.permission_id).toBe('p-1');
    expect(calls[0].url).toBe('http://daemon.test/permissions/p-1');
  });

  test('decidePermission posts decide body', async () => {
    responses.push(new Response(JSON.stringify({ permission_id: 'p-1', status: 'approved', decided_at: 't' }), { status: 200 }));
    const client = makeClient();
    const out = await client.decidePermission('p-1', { decision: 'approve', remember: 'this_dispatch' });
    expect(out.status).toBe('approved');
    expect(calls[0].url).toBe('http://daemon.test/permissions/p-1/decide');
    expect(calls[0].init?.method).toBe('POST');
  });
});
```

(Adapt the constructor call to match the actual `PenumbraClient` constructor signature — Step 1's grep reveals it. The above assumes a `baseUrl` option; if the real client derives the URL from `storageRoot`, the test must point its fixture at a baseUrl that matches what `PenumbraClient` synthesises.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/agentchat/test/penumbra-client.test.ts -t "permission"`

Expected: methods don't exist.

- [ ] **Step 4: Add the methods**

In `packages/agentchat/src/penumbra-client.ts`, add (matching the existing method style):

```ts
import type { CreatePermissionRequest, ApprovePermissionRequest, PermissionRequestRow } from '@penumbra/core';

export interface CreatePermissionResult {
  permission_id: string;
  status: 'pending';
  ttl_at: string;
}
export interface DecidePermissionResult {
  permission_id: string;
  status: 'approved' | 'rejected';
  decided_at: string;
}

// ... inside class PenumbraClient ...

  async createPermission(body: CreatePermissionRequest): Promise<CreatePermissionResult> {
    const r = await fetch(`${this.baseUrl}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new PenumbraHttpError(r.status, await r.text());
    return await r.json() as CreatePermissionResult;
  }

  async getPermission(permission_id: string): Promise<{ permission: PermissionRequestRow }> {
    const r = await fetch(`${this.baseUrl}/permissions/${encodeURIComponent(permission_id)}`);
    if (!r.ok) throw new PenumbraHttpError(r.status, await r.text());
    return await r.json() as { permission: PermissionRequestRow };
  }

  async listPermissions(opts: { status?: string; conversation_id?: string; parent_handoff_id?: string } = {}): Promise<{ permissions: PermissionRequestRow[] }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.conversation_id) qs.set('conversation_id', opts.conversation_id);
    if (opts.parent_handoff_id) qs.set('parent_handoff_id', opts.parent_handoff_id);
    const url = qs.toString() ? `${this.baseUrl}/permissions?${qs.toString()}` : `${this.baseUrl}/permissions`;
    const r = await fetch(url);
    if (!r.ok) throw new PenumbraHttpError(r.status, await r.text());
    return await r.json() as { permissions: PermissionRequestRow[] };
  }

  async decidePermission(permission_id: string, body: ApprovePermissionRequest): Promise<DecidePermissionResult> {
    const r = await fetch(`${this.baseUrl}/permissions/${encodeURIComponent(permission_id)}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new PenumbraHttpError(r.status, await r.text());
    return await r.json() as DecidePermissionResult;
  }
```

(Matching: `baseUrl` field, `PenumbraHttpError` class name — confirm via the existing `getHandoff`/`approveHandoff` methods. If those use a different error wrapper, mirror that.)

- [ ] **Step 5: Run test to verify pass + typecheck**

Run:
```bash
bun test packages/agentchat/test/penumbra-client.test.ts -t "permission"
bun run typecheck
```

Expected: 3 pass; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/penumbra-client.ts packages/agentchat/test/penumbra-client.test.ts
git commit -m "feat(agentchat): PenumbraClient — create/get/list/decide permission methods"
```

---

## Task 15: PermissionDaemonClient — SSE consumer + waiter map

**Files:**
- Create: `packages/agentchat/src/worker/permission-daemon-client.ts`
- Test: `packages/agentchat/test/worker/permission-daemon-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/permission-daemon-client.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { PermissionDaemonClient } from '../../src/worker/permission-daemon-client.js';

interface FakeClient {
  createPermission: (body: any) => Promise<any>;
  getPermission: (id: string) => Promise<any>;
  decidePermission: (id: string, body: any) => Promise<any>;
}

class FakeEventSource {
  listeners = new Map<string, Set<(evt: any) => void>>();
  closed = false;
  addEventListener(name: string, fn: (evt: any) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  emit(name: string, payload: { permission_id: string; data: any }) {
    const data = JSON.stringify(payload.data);
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data, lastEventId: `seq:${1}` });
    }
  }
  close() { this.closed = true; }
}

function makeFakeClient(): FakeClient {
  return {
    createPermission: async (body) => ({ permission_id: body.permission_id, status: 'pending', ttl_at: 't' }),
    getPermission: async (id) => ({ permission: { permission_id: id, status: 'pending' } }),
    decidePermission: async () => ({ status: 'approved' }),
  };
}

describe('PermissionDaemonClient', () => {
  test('requestPermission registers waiter BEFORE POST and resolves on SSE decided event', async () => {
    const fakeEs = new FakeEventSource();
    const client = new PermissionDaemonClient({
      penumbraClient: makeFakeClient() as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });
    // Simulate operator approving via SSE.
    fakeEs.emit('permission.decided', {
      permission_id: 'perm-fixed',
      data: { permission_id: 'perm-fixed', decision: 'approve', remember: 'this_dispatch', reason: null },
    });
    const result = await promise;
    expect(result.decision).toBe('approve');
    expect(result.remember).toBe('this_dispatch');
  });

  test('requestPermission rejects on permission.expired', async () => {
    const fakeEs = new FakeEventSource();
    const client = new PermissionDaemonClient({
      penumbraClient: makeFakeClient() as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    const promise = client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    });
    fakeEs.emit('permission.expired', {
      permission_id: 'perm-fixed',
      data: { permission_id: 'perm-fixed', ttl_at: 't', expired_at: 't' },
    });
    await expect(promise).rejects.toThrow(/expired/);
  });

  test('requestPermission with createPermission HTTP failure rejects', async () => {
    const fakeEs = new FakeEventSource();
    const fakeClient = makeFakeClient();
    fakeClient.createPermission = async () => { throw new Error('http 500'); };
    const client = new PermissionDaemonClient({
      penumbraClient: fakeClient as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();

    await expect(client.requestPermission({
      parent_handoff_id: 'h-1', conversation_id: 'c', agent_name: 'a',
      tool_name: 't', raw_input: {}, ttl_seconds: 60,
    })).rejects.toThrow(/http 500/);
  });

  test('decided event for an unknown id is silently ignored', async () => {
    const fakeEs = new FakeEventSource();
    const client = new PermissionDaemonClient({
      penumbraClient: makeFakeClient() as any,
      makeEventSource: () => fakeEs as any,
      uuid: () => 'perm-fixed',
      log: { info: () => {}, warn: () => {} } as any,
    });
    await client.start();
    // No throw — just observes that emitting an unknown id doesn't crash.
    fakeEs.emit('permission.decided', {
      permission_id: 'unknown',
      data: { permission_id: 'unknown', decision: 'approve' },
    });
    expect(fakeEs.closed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agentchat/test/worker/permission-daemon-client.test.ts`

Expected: module-not-found.

- [ ] **Step 3: Implement the daemon client**

Create `packages/agentchat/src/worker/permission-daemon-client.ts`:

```ts
import type { Logger } from '@penumbra/core';
import type { PenumbraClient } from '../penumbra-client.js';

export interface PermissionDecisionResult {
  decision: 'approve' | 'reject';
  remember: 'this_call' | 'this_dispatch' | null;
  reason: string | null;
}

export interface RequestPermissionInput {
  parent_handoff_id: string;
  conversation_id: string;
  agent_name: string;
  tool_name: string;
  raw_input: unknown;
  ttl_seconds: number;
}

interface Waiter {
  resolve: (d: PermissionDecisionResult) => void;
  reject: (e: Error) => void;
}

export interface EventSourceLike {
  addEventListener(name: string, fn: (evt: { data: string; lastEventId?: string }) => void): void;
  close(): void;
}

export interface PermissionDaemonClientOpts {
  penumbraClient: Pick<PenumbraClient, 'createPermission' | 'getPermission'>;
  /** Factory so tests can inject a fake. Defaults to native EventSource against `${baseUrl}/permissions/events`. */
  makeEventSource: () => EventSourceLike;
  uuid: () => string;
  log: Logger;
}

export class PermissionDaemonClient {
  private waiters = new Map<string, Waiter>();
  private es: EventSourceLike | null = null;

  constructor(private readonly opts: PermissionDaemonClientOpts) {}

  async start(): Promise<void> {
    if (this.es) return;
    this.es = this.opts.makeEventSource();
    this.es.addEventListener('permission.decided', (evt) => {
      let payload: any;
      try { payload = JSON.parse(evt.data); } catch { return; }
      const w = this.waiters.get(payload.permission_id);
      if (!w) return;
      this.waiters.delete(payload.permission_id);
      w.resolve({
        decision: payload.decision,
        remember: payload.remember ?? null,
        reason: payload.reason ?? null,
      });
    });
    this.es.addEventListener('permission.expired', (evt) => {
      let payload: any;
      try { payload = JSON.parse(evt.data); } catch { return; }
      const w = this.waiters.get(payload.permission_id);
      if (!w) return;
      this.waiters.delete(payload.permission_id);
      w.reject(new Error(`permission ${payload.permission_id} expired`));
    });
  }

  stop(): void {
    this.es?.close();
    this.es = null;
    for (const w of this.waiters.values()) {
      w.reject(new Error('PermissionDaemonClient stopped'));
    }
    this.waiters.clear();
  }

  async requestPermission(input: RequestPermissionInput): Promise<PermissionDecisionResult> {
    if (!this.es) throw new Error('PermissionDaemonClient not started');
    const permission_id = this.opts.uuid();
    // Register waiter BEFORE the POST so an instant decision can't slip past.
    const promise = new Promise<PermissionDecisionResult>((resolve, reject) => {
      this.waiters.set(permission_id, { resolve, reject });
    });
    try {
      await this.opts.penumbraClient.createPermission({
        permission_id,
        parent_handoff_id: input.parent_handoff_id,
        conversation_id: input.conversation_id,
        agent_name: input.agent_name,
        tool_name: input.tool_name,
        raw_input: input.raw_input,
        ttl_seconds: input.ttl_seconds,
      });
    } catch (err) {
      this.waiters.delete(permission_id);
      throw err;
    }
    return promise;
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/agentchat/test/worker/permission-daemon-client.test.ts`

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/permission-daemon-client.ts packages/agentchat/test/worker/permission-daemon-client.test.ts
git commit -m "feat(agentchat): PermissionDaemonClient — SSE consumer + waiter map + register-before-POST"
```

---

## Task 16: Allowlist matcher

**Files:**
- Create: `packages/agentchat/src/worker/allowlist-matcher.ts`
- Test: `packages/agentchat/test/worker/allowlist-matcher.test.ts`
- Modify: `packages/agentchat/package.json` (add `picomatch` if missing)

- [ ] **Step 1: Verify picomatch availability**

Run: `node -e "require('picomatch')"`

If it errors with "Cannot find module 'picomatch'", add it to `packages/agentchat/package.json` dependencies via:

```bash
cd packages/agentchat && bun add picomatch && cd -
```

(Picomatch is small and already transitively present via `fast-glob`/similar; the explicit add documents the dep.)

- [ ] **Step 2: Write the failing test**

Create `packages/agentchat/test/worker/allowlist-matcher.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { matchAllowlist } from '../../src/worker/allowlist-matcher.js';

describe('matchAllowlist', () => {
  test('exact match (no glob chars) succeeds', () => {
    expect(matchAllowlist(['fs.readTextFile'], new Set(), 'fs.readTextFile')).toBe(true);
  });

  test('exact match against a different name fails', () => {
    expect(matchAllowlist(['fs.readTextFile'], new Set(), 'fs.writeTextFile')).toBe(false);
  });

  test('glob with * matches its scope but not other servers', () => {
    expect(matchAllowlist(['mcp__penumbra__*'], new Set(), 'mcp__penumbra__chain.list_agents')).toBe(true);
    expect(matchAllowlist(['mcp__penumbra__*'], new Set(), 'mcp__sirius__sirius_chat')).toBe(false);
  });

  test('glob with ? matches single-char gap', () => {
    expect(matchAllowlist(['fs.read?extFile'], new Set(), 'fs.readTextFile')).toBe(true);
  });

  test('character class [...] is treated as glob', () => {
    expect(matchAllowlist(['mcp__[ps]enumbra__*'], new Set(), 'mcp__penumbra__x')).toBe(true);
    expect(matchAllowlist(['mcp__[ps]enumbra__*'], new Set(), 'mcp__qenumbra__x')).toBe(false);
  });

  test('per-dispatch cache short-circuits even when not in yaml list', () => {
    expect(matchAllowlist([], new Set(['ephemeral.tool']), 'ephemeral.tool')).toBe(true);
  });

  test('empty allowlist + empty cache → no match', () => {
    expect(matchAllowlist([], new Set(), 'fs.readTextFile')).toBe(false);
  });

  test('multiple patterns: any match wins', () => {
    expect(matchAllowlist(['fs.*', 'mcp__penumbra__*'], new Set(), 'mcp__penumbra__memory.recall')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/agentchat/test/worker/allowlist-matcher.test.ts`

Expected: module-not-found.

- [ ] **Step 4: Implement the matcher**

Create `packages/agentchat/src/worker/allowlist-matcher.ts`:

```ts
import picomatch from 'picomatch';

const GLOB_CHARS = /[*?[]/;

export function matchAllowlist(
  yamlList: readonly string[],
  perDispatchCache: ReadonlySet<string>,
  tool_name: string,
): boolean {
  if (perDispatchCache.has(tool_name)) return true;
  for (const pattern of yamlList) {
    if (GLOB_CHARS.test(pattern)) {
      if (picomatch(pattern)(tool_name)) return true;
    } else {
      if (pattern === tool_name) return true;
    }
  }
  return false;
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `bun test packages/agentchat/test/worker/allowlist-matcher.test.ts`

Expected: 8 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/worker/allowlist-matcher.ts packages/agentchat/test/worker/allowlist-matcher.test.ts packages/agentchat/package.json packages/agentchat/bun.lockb
git commit -m "feat(agentchat): allowlist matcher — exact ∪ glob ∪ per-dispatch cache"
```

(If `bun.lockb` did not change because picomatch was already present, omit it from the add.)

---

## Task 17: Extend `createPermissionCallback` to v2 form

**Files:**
- Modify: `packages/agentchat/src/worker/permission-callback.ts`
- Modify: `packages/agentchat/test/worker/permission-callback.test.ts` (extend existing)

- [ ] **Step 1: Write the failing tests**

Append to `packages/agentchat/test/worker/permission-callback.test.ts`:

```ts
import { createPermissionCallback } from '../../src/worker/permission-callback.js';

describe('createPermissionCallback (v2 form, with allowlist + daemon)', () => {
  function makeFakeDaemon(decision: 'approve' | 'reject', remember: 'this_call' | 'this_dispatch' | null = null) {
    return {
      requestPermission: async () => ({ decision, remember, reason: null }),
    } as any;
  }

  it("v2: trustMode='all' short-circuits to approve without daemon round-trip", async () => {
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: 'all',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c-1', agentName: 'claude-acp-sonnet',
      ttlSeconds: 300,
      daemonClient: { requestPermission: async () => { calls.push('called'); return { decision: 'reject', remember: null, reason: null }; } } as any,
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {} })).toBe('approve');
    expect(calls).toEqual([]);
  });

  it("v2: allowlist match short-circuits to approve under 'config'", async () => {
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: ['mcp__penumbra__*'],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: { requestPermission: async () => { calls.push('called'); return { decision: 'reject', remember: null, reason: null }; } } as any,
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'mcp__penumbra__chain.list_agents', rawInput: {} })).toBe('approve');
    expect(calls).toEqual([]);
  });

  it("v2: off-list under 'config' calls daemon and returns its decision", async () => {
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: ['mcp__penumbra__*'],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: makeFakeDaemon('approve'),
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'mcp__sirius__chat', rawInput: { msg: 'hi' } })).toBe('approve');
  });

  it("v2: 'this_dispatch' remember adds tool to per-dispatch cache; second call short-circuits", async () => {
    const perDispatch = new Set<string>();
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: {
        requestPermission: async (input: any) => {
          calls.push(input.tool_name);
          return { decision: 'approve', remember: 'this_dispatch', reason: null };
        },
      } as any,
      perDispatchAllowlist: perDispatch,
    });
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {} })).toBe('approve');
    expect(calls).toEqual(['fs.readTextFile']);
    expect(perDispatch.has('fs.readTextFile')).toBe(true);
    // Second call to the same tool should NOT round-trip the daemon.
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {} })).toBe('approve');
    expect(calls).toEqual(['fs.readTextFile']); // still only one call
  });

  it("v2: daemon Promise rejection ⇒ 'reject' (fail closed)", async () => {
    const cb = createPermissionCallback({
      trustMode: 'config',
      allowedTools: [],
      handoffId: 'h-1', conversationId: 'c', agentName: 'a',
      ttlSeconds: 300,
      daemonClient: { requestPermission: async () => { throw new Error('expired'); } } as any,
      perDispatchAllowlist: new Set(),
    });
    expect(await cb({ toolName: 'fs.readTextFile', rawInput: {} })).toBe('reject');
  });
});
```

(The existing v1 tests at the top of the file remain untouched — they exercise the v1 single-arg form. The v2 form is detected by passing an opts object instead of a string.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agentchat/test/worker/permission-callback.test.ts -t "v2 form"`

Expected: 5 fail (factory only accepts the single-arg v1 form).

- [ ] **Step 3: Extend the factory**

Replace `packages/agentchat/src/worker/permission-callback.ts` with the dual-form factory:

```ts
import type { PermissionDecision, ToolCallContext } from '../sdk/adapter.js';
import type { PermissionDaemonClient } from './permission-daemon-client.js';
import { matchAllowlist } from './allowlist-matcher.js';

export interface PermissionCallbackV2Opts {
  trustMode: 'all' | 'config';
  allowedTools: readonly string[];
  handoffId: string;
  conversationId: string;
  agentName: string;
  ttlSeconds: number;
  daemonClient: Pick<PermissionDaemonClient, 'requestPermission'>;
  perDispatchAllowlist: Set<string>;
}

export type PermissionCallback = (toolCall: ToolCallContext) => Promise<PermissionDecision>;

/** v1 form: trust-mode-only blanket decision. Kept for backward compat with callers
 *  that don't yet pass the v2 opts object. */
export function createPermissionCallback(trustMode?: 'all' | 'config'): PermissionCallback;
/** v2 form: allowlist + daemon-mediated operator pause. */
export function createPermissionCallback(opts: PermissionCallbackV2Opts): PermissionCallback;
export function createPermissionCallback(arg?: 'all' | 'config' | PermissionCallbackV2Opts): PermissionCallback {
  // v1 dispatch: no opts object, OR a bare string.
  if (arg === undefined || typeof arg === 'string') {
    const trustMode = arg ?? 'all';
    return async (_toolCall: ToolCallContext): Promise<PermissionDecision> => {
      return trustMode === 'all' ? 'approve' : 'reject';
    };
  }

  // v2 dispatch: opts object.
  const opts = arg;
  return async (toolCall: ToolCallContext): Promise<PermissionDecision> => {
    if (opts.trustMode === 'all') return 'approve';
    if (matchAllowlist(opts.allowedTools, opts.perDispatchAllowlist, toolCall.toolName)) return 'approve';
    try {
      const result = await opts.daemonClient.requestPermission({
        parent_handoff_id: opts.handoffId,
        conversation_id: opts.conversationId,
        agent_name: opts.agentName,
        tool_name: toolCall.toolName,
        raw_input: toolCall.rawInput,
        ttl_seconds: opts.ttlSeconds,
      });
      if (result.decision === 'approve' && result.remember === 'this_dispatch') {
        opts.perDispatchAllowlist.add(toolCall.toolName);
      }
      return result.decision;
    } catch {
      return 'reject';
    }
  };
}
```

- [ ] **Step 4: Run test to verify pass + regression on v1 tests**

Run: `bun test packages/agentchat/test/worker/permission-callback.test.ts`

Expected: 3 v1 tests + 5 v2 tests = 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/permission-callback.ts packages/agentchat/test/worker/permission-callback.test.ts
git commit -m "feat(agentchat): createPermissionCallback v2 — allowlist + daemon round-trip + per-dispatch cache"
```

---

## Task 18: Yaml types — `allowed_tools` + `permission_ttl_s`

**Files:**
- Modify: `packages/agentchat/src/config/types.ts`
- Test: `packages/agentchat/test/config/load.test.ts` (extend existing)

- [ ] **Step 1: Inspect the current types**

Run: `grep -n 'allowed_tools\|permission_ttl\|interface AgentOptions\|interface AgentConfig' packages/agentchat/src/config/types.ts`

Note where `options` is typed for an agent config. The new fields go inside that `options` shape.

- [ ] **Step 2: Write the failing test**

Append to `packages/agentchat/test/config/load.test.ts`:

```ts
import { loadConfig } from '../../src/config/load.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('parses allowed_tools and permission_ttl_s from agent options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: claude-acp-sonnet
    adapter: stdio-acp
    binary: claude-agent-acp
    args: []
    options:
      allowed_tools:
        - "mcp__penumbra__*"
        - "fs.readTextFile"
      permission_ttl_s: 600
`);
  const cfg = loadConfig(path);
  const a = cfg.agents.find((x: any) => x.name === 'claude-acp-sonnet');
  expect(a?.options?.allowed_tools).toEqual(['mcp__penumbra__*', 'fs.readTextFile']);
  expect(a?.options?.permission_ttl_s).toBe(600);
});

it('omitted allowed_tools defaults to undefined (worker treats as [])', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: claude-acp-sonnet
    adapter: stdio-acp
    binary: claude-agent-acp
    args: []
`);
  const cfg = loadConfig(path);
  const a = cfg.agents.find((x: any) => x.name === 'claude-acp-sonnet');
  expect(a?.options?.allowed_tools).toBeUndefined();
});
```

(Adjust the import path of `it`/`expect` and any framework setup to match the existing file's style.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/agentchat/test/config/load.test.ts -t "allowed_tools"`

Expected: type-check or runtime mismatch on options shape.

- [ ] **Step 4: Extend the types**

In `packages/agentchat/src/config/types.ts`, find the agent options type/interface and add (matching the existing field style):

```ts
  /** Tool name allowlist for chain_trust_mode='config'. Strings without glob chars are exact-matched; strings containing *?[ are matched as picomatch globs. Default: undefined ⇒ treated as []. */
  allowed_tools?: string[];
  /** Override of PENUMBRA_PERMISSION_TTL_S for this agent. Seconds. */
  permission_ttl_s?: number;
```

If there's a corresponding zod schema (e.g., `AgentOptionsSchema`), add the same fields there:

```ts
  allowed_tools: z.array(z.string()).optional(),
  permission_ttl_s: z.number().int().positive().optional(),
```

- [ ] **Step 5: Run test to verify pass + typecheck**

Run:
```bash
bun test packages/agentchat/test/config/load.test.ts -t "allowed_tools"
bun run typecheck
```

Expected: 2 pass; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/config/types.ts packages/agentchat/test/config/load.test.ts
git commit -m "feat(agentchat): yaml — agent options gain allowed_tools + permission_ttl_s"
```

---

## Task 19: Wire daemon client + v2 callback into `agentchat-worker.ts`

**Files:**
- Modify: `packages/agentchat/bin/agentchat-worker.ts`

(No new test — the integration is exercised end-to-end in the smoke test, Task 23. Existing worker tests should continue to pass.)

- [ ] **Step 1: Add imports**

At the top of `packages/agentchat/bin/agentchat-worker.ts`, add (matching the existing import style):

```ts
import { PermissionDaemonClient } from '../src/worker/permission-daemon-client.js';
import { createPermissionCallback } from '../src/worker/permission-callback.js';
import { systemUuid } from '@penumbra/core';
```

- [ ] **Step 2: Boot the daemon client once at startup**

After `worktreeManager` is constructed (around line 71), add:

```ts
const baseDaemonUrl = (client as any).baseUrl ?? `http://127.0.0.1:${(client as any).port}`;
const permissionDaemonClient = new PermissionDaemonClient({
  penumbraClient: client,
  makeEventSource: () => new EventSource(`${baseDaemonUrl}/permissions/events`) as any,
  uuid: systemUuid,
  log,
});
await permissionDaemonClient.start();
```

(If `EventSource` is not globally available in bun, import it: `import { EventSource } from 'eventsource';` and add the package as a dep — but bun ships its own `EventSource` since 1.1, so this is usually unnecessary. Verify with `bun -e "console.log(typeof EventSource)"` — should print `function`.)

- [ ] **Step 3: Replace the v1 callback in the dispatch closure**

Inside the `dispatch:` callback (around line 122 — find `const trustMode = ...` and `const requestPermission = createPermissionCallback(trustMode);`), replace with:

```ts
    const trustMode = (handoff.chain_trust_mode ?? defaultTrust) as 'all' | 'config';
    const maxHops = handoff.chain_max_hops ?? defaultMaxHops;

    // Resolve agent's per-dispatch permission policy.
    const agentCfg = config.agents.find((a) => a.name === handoff.to_agent);
    const allowedTools = (agentCfg?.options as any)?.allowed_tools ?? [];
    const ttlSeconds = (agentCfg?.options as any)?.permission_ttl_s
      ?? Number(process.env.PENUMBRA_PERMISSION_TTL_S ?? 300);
    const perDispatchAllowlist = new Set<string>();

    const requestPermission = createPermissionCallback({
      trustMode,
      allowedTools,
      handoffId: handoff.handoff_id as string,
      conversationId: handoff.conversation_id,
      agentName: handoff.to_agent,
      ttlSeconds,
      daemonClient: permissionDaemonClient,
      perDispatchAllowlist,
    });
```

- [ ] **Step 4: Add cleanup to shutdown handler**

Find the existing `shutdown` async function (around line 208). Add `permissionDaemonClient.stop();` before `process.exit(0)`:

```ts
const shutdown = async (sig: string) => {
  log.info({ sig }, 'shutting down');
  controlAbort.abort();
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  await eventSource.stop();
  permissionDaemonClient.stop();
  dispatcher.stop();
  await dispatcher.idle();
  process.exit(0);
};
```

- [ ] **Step 5: Typecheck + run worker test suite**

Run:
```bash
bun run typecheck
bun test packages/agentchat/test/worker/
```

Expected: typecheck exit 0; all worker tests pass (the v1 form is preserved for any tests that still use it).

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/bin/agentchat-worker.ts
git commit -m "feat(agentchat): worker — boot PermissionDaemonClient + wire v2 callback per-dispatch"
```

---

## Task 20: stdio-acp adapter — tool-name extraction guard

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/test/adapters/stdio-acp.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agentchat/test/adapters/stdio-acp.test.ts` (mirror the file's existing test style for `session/request_permission`):

```ts
  it('returns cancelled locally without invoking requestPermission when tool title and name are both missing', async () => {
    const { adapter, mockClient, sentRequests } = setupAdapterWithMockedClient({ fsReadTextFile: true });
    const requestPermission = vi.fn().mockResolvedValue('approve');
    const dispatchPromise = adapter.dispatch({
      prompt: 'hi',
      conversation: { id: 'c-1', project_id: null },
      config: {},
      signal: new AbortController().signal,
      requestPermission,
    });
    await mockClient.simulateIncomingRequest({
      id: 999,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-123',
        options: [{ optionId: 'a', kind: 'allow_always', name: 'Allow' }],
        // toolCall is present but missing both title and name
        toolCall: { rawInput: { whatever: 1 } },
      },
    });
    await mockClient.simulateAgentMessage({ text: 'done' });
    await mockClient.simulatePromptResolve();
    await dispatchPromise;

    expect(requestPermission).not.toHaveBeenCalled();
    const reply = sentRequests.find((r) => r.id === 999);
    expect(reply?.result).toEqual({ outcome: { outcome: 'cancelled' } });
  });
```

(`setupAdapterWithMockedClient` and `mockClient` already exist in this file from the v1 tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "tool title and name are both missing"`

Expected: fail — the current handler still calls requestPermission with `toolName: 'unknown'`.

- [ ] **Step 3: Add the guard**

In `packages/agentchat/src/adapters/stdio-acp.ts`, find the handler block at lines 91-135 and modify the inner block where `toolName` is extracted. Replace the section starting `let decision: 'approve' | 'reject' = 'approve';` and ending `decision = 'reject';` with:

```ts
          const toolName: string | null =
            (typeof params?.toolCall?.title === 'string' && params.toolCall.title)
            || (typeof params?.toolCall?.name === 'string' && params.toolCall.name)
            || null;
          if (!toolName) {
            // Operator can't make an informed decision on an unnamed tool;
            // allowlist can't match. Fail closed locally (no callback invocation,
            // no daemon row).
            return { outcome: { outcome: 'cancelled' } };
          }

          let decision: 'approve' | 'reject' = 'approve';
          try {
            decision = await input.requestPermission({
              toolName,
              rawInput: params?.toolCall?.rawInput ?? params?.toolCall ?? null,
            });
          } catch {
            decision = 'reject';
          }
```

(Keep the surrounding outer `if (!input.requestPermission)` fallback block unchanged — that one preserves backward-compat for tests that bypass the worker.)

- [ ] **Step 4: Run test to verify pass + full adapter regression**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts`

Expected: all stdio-acp tests pass (existing 6 + 3 v1 + 1 new guard = 10).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/test/adapters/stdio-acp.test.ts
git commit -m "fix(agentchat): stdio-acp — cancel locally when toolCall has no title or name (no 'unknown' decisions)"
```

---

## Task 21: MCP daemon-client methods + tools registration

**Files:**
- Modify: `packages/mcp/src/daemon-client.ts`
- Create: `packages/mcp/src/tools/permission-list-pending.ts`
- Create: `packages/mcp/src/tools/permission-get.ts`
- Create: `packages/mcp/src/tools/permission-approve.ts`
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/tools/permission-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp/test/tools/permission-tools.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  permissionListPendingHandler, PermissionListPendingInputShape,
} from '../../src/tools/permission-list-pending.js';
import {
  permissionGetHandler, PermissionGetInputShape,
} from '../../src/tools/permission-get.js';
import {
  permissionApproveHandler, PermissionApproveInputShape,
} from '../../src/tools/permission-approve.js';

function makeFakeDaemon() {
  return {
    listPermissions: async (opts: any) => ({ permissions: [{ permission_id: 'p-1', status: 'pending', tool_name: 't', conversation_id: opts.conversation_id ?? 'c' }] }),
    getPermission: async (id: string) => ({ permission: { permission_id: id, status: 'pending', tool_name: 't' } }),
    approvePermission: async (id: string, body: any) => ({ permission_id: id, status: body.decision === 'approve' ? 'approved' : 'rejected', decided_at: 't' }),
  } as any;
}

describe('permission-list-pending tool', () => {
  test('forwards conversation_id filter to daemon and returns rows', async () => {
    const handler = permissionListPendingHandler(makeFakeDaemon());
    const out = await handler({ conversation_id: 'conv-123' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.permissions[0].conversation_id).toBe('conv-123');
  });
  test('input shape declares optional fields', () => {
    expect(PermissionListPendingInputShape).toBeDefined();
  });
});

describe('permission-get tool', () => {
  test('returns the row', async () => {
    const handler = permissionGetHandler(makeFakeDaemon());
    const out = await handler({ permission_id: 'p-1' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.permission.permission_id).toBe('p-1');
  });
  test('returns 404-shaped body when daemon throws not_found', async () => {
    const fake = makeFakeDaemon();
    fake.getPermission = async () => { const e: any = new Error('not_found'); e.status = 404; throw e; };
    const handler = permissionGetHandler(fake);
    const out = await handler({ permission_id: 'nope' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.error?.code).toBe('not_found');
  });
});

describe('permission-approve tool', () => {
  test('approve passes through', async () => {
    const handler = permissionApproveHandler(makeFakeDaemon());
    const out = await handler({ permission_id: 'p-1', decision: 'approve', remember: 'this_dispatch' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.status).toBe('approved');
  });
  test('reject passes through', async () => {
    const handler = permissionApproveHandler(makeFakeDaemon());
    const out = await handler({ permission_id: 'p-1', decision: 'reject', reason: 'no third-party calls' });
    const body = JSON.parse((out.content[0] as any).text);
    expect(body.status).toBe('rejected');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp/test/tools/permission-tools.test.ts`

Expected: module-not-found.

- [ ] **Step 3: Add daemon client methods**

In `packages/mcp/src/daemon-client.ts`, add three methods (matching existing `listHandoffs`/`getHandoff`/`approveHandoff` style):

```ts
import type { PermissionRequestRow, ApprovePermissionRequest } from '@penumbra/core';

  async listPermissions(opts: { status?: string; conversation_id?: string; parent_handoff_id?: string } = {}): Promise<{ permissions: PermissionRequestRow[] }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.conversation_id) qs.set('conversation_id', opts.conversation_id);
    if (opts.parent_handoff_id) qs.set('parent_handoff_id', opts.parent_handoff_id);
    const url = qs.toString() ? `${this.baseUrl}/permissions?${qs}` : `${this.baseUrl}/permissions`;
    const r = await fetch(url);
    if (!r.ok) throw new DaemonHttpError(r.status, await r.text());
    return await r.json();
  }

  async getPermission(permission_id: string): Promise<{ permission: PermissionRequestRow }> {
    const r = await fetch(`${this.baseUrl}/permissions/${encodeURIComponent(permission_id)}`);
    if (!r.ok) throw new DaemonHttpError(r.status, await r.text());
    return await r.json();
  }

  async approvePermission(permission_id: string, body: ApprovePermissionRequest): Promise<{ permission_id: string; status: string; decided_at: string }> {
    const r = await fetch(`${this.baseUrl}/permissions/${encodeURIComponent(permission_id)}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new DaemonHttpError(r.status, await r.text());
    return await r.json();
  }
```

- [ ] **Step 4: Implement the three MCP tool wrappers**

Create `packages/mcp/src/tools/permission-list-pending.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const PermissionListPendingInputShape = {
  conversation_id: z.string().optional().describe('Filter to a single conversation.'),
  parent_handoff_id: z.string().optional().describe('Filter to a single dispatch.'),
  status: z.string().optional().describe('Comma-separated status filter (default: pending). Allowed: pending,approved,rejected,expired.'),
};

export const permissionListPendingHandler = (daemon: DaemonClient) => async (
  args: { conversation_id?: string; parent_handoff_id?: string; status?: string },
) => {
  const { permissions } = await daemon.listPermissions({
    status: args.status,
    conversation_id: args.conversation_id,
    parent_handoff_id: args.parent_handoff_id,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify({ permissions }, null, 2) }] };
};
```

Create `packages/mcp/src/tools/permission-get.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { DaemonHttpError } from '../daemon-client.js';

export const PermissionGetInputShape = {
  permission_id: z.string().min(1).describe('The permission_id to fetch.'),
};

export const permissionGetHandler = (daemon: DaemonClient) => async (args: { permission_id: string }) => {
  try {
    const { permission } = await daemon.getPermission(args.permission_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ permission }, null, 2) }] };
  } catch (err) {
    if (err instanceof DaemonHttpError && err.status === 404) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'not_found', message: `permission ${args.permission_id} not found` } }, null, 2) }],
      };
    }
    throw err;
  }
};
```

Create `packages/mcp/src/tools/permission-approve.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const PermissionApproveInputShape = {
  permission_id: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  remember: z.enum(['this_call', 'this_dispatch']).optional().describe('Default: this_call. Use "this_dispatch" to short-circuit subsequent calls of the same tool name within this dispatch.'),
  reason: z.string().optional(),
};

export const permissionApproveHandler = (daemon: DaemonClient) => async (
  args: { permission_id: string; decision: 'approve' | 'reject'; remember?: 'this_call' | 'this_dispatch'; reason?: string },
) => {
  const r = await daemon.approvePermission(args.permission_id, {
    decision: args.decision,
    remember: args.remember,
    reason: args.reason,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
};
```

- [ ] **Step 5: Register the tools in mcp/server.ts**

In `packages/mcp/src/server.ts`, add the imports near the existing tool imports:

```ts
import { PermissionListPendingInputShape, permissionListPendingHandler } from './tools/permission-list-pending.js';
import { PermissionGetInputShape, permissionGetHandler } from './tools/permission-get.js';
import { PermissionApproveInputShape, permissionApproveHandler } from './tools/permission-approve.js';
```

Add the three `server.registerTool(...)` calls after the existing `handoff.*` tools (around line 60), matching the same style:

```ts
  server.registerTool(
    'permission.list_pending',
    { description: 'List pending tool-permission requests awaiting operator approval. Optional filters: conversation_id, parent_handoff_id, status (comma-separated).', inputSchema: PermissionListPendingInputShape },
    permissionListPendingHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'permission.get',
    { description: 'Returns a single permission_request row including raw_input_json for operator review before deciding.', inputSchema: PermissionGetInputShape },
    permissionGetHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
  server.registerTool(
    'permission.approve',
    { description: 'Approve or reject a pending permission_request. remember="this_dispatch" auto-approves subsequent calls of the same tool within this dispatch.', inputSchema: PermissionApproveInputShape },
    permissionApproveHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
  );
```

- [ ] **Step 6: Run tests + typecheck**

Run:
```bash
bun test packages/mcp/test/tools/permission-tools.test.ts
bun run typecheck
```

Expected: 7 pass; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/tools/permission-list-pending.ts packages/mcp/src/tools/permission-get.ts packages/mcp/src/tools/permission-approve.ts packages/mcp/src/daemon-client.ts packages/mcp/src/server.ts packages/mcp/test/tools/permission-tools.test.ts
git commit -m "feat(mcp): three permission_* tools (list_pending, get, approve) + daemon-client methods"
```

---

## Task 22: Full test suite green-check

**Files:** none new.

- [ ] **Step 1: Run the full suite**

Run: `bun test`

Expected: all packages pass. Take note of the new total (should be original 768 + new tests added in Tasks 1–21 ≈ 800+).

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 3: If anything fails**

Triage by package — fix root causes (don't paper over). Common pitfalls:
- The `Services` interface added 3 fields; any test stub building a partial `Services` may need a cast. Search: `grep -rn 'as unknown as Services' packages/`.
- The `Services` boot in `serve.ts` may need real instantiation order — the `permissionEvents` bus must be constructed before any route is registered.
- If `EventSource` is undefined in the worker test environment, the boot path of `agentchat-worker.ts` won't be exercised by the unit tests; the integration smoke (Task 23) is the canonical check.

- [ ] **Step 4: Commit any green-fixing patches**

```bash
git add -A
git commit -m "test: green the full suite after Phase 1c v2 implementation"
```

(If no patches needed, skip.)

---

## Task 23: Smoke test (MAESTRO-SIDE — implementer should stop after Task 22)

The maestro performs these scenarios manually after the implementer wraps Task 22.

**Setup:**

- [ ] **Step 1: Restart workers to load all v2 code**

```bash
pkill -TERM -f 'agentchat-worker.ts' ; sleep 2
for w in primary b c d; do
  PENUMBRA_PERMISSION_TTL_S=10 nohup bun packages/agentchat/bin/agentchat-worker.ts \
    --storage-root /tmp/penumbra-live --worker-id worker-$w > /tmp/worker-$w.log 2>&1 &
done
sleep 5
```

(`PENUMBRA_PERMISSION_TTL_S=10` is for Smoke D's expiry test. Production use would not crank this down.)

- [ ] **Step 2: Edit `~/.config/agentchat/agentchat.yaml` for the smoke**

Add to the `claude-acp-sonnet` agent:

```yaml
    options:
      # ... existing keys ...
      allowed_tools:
        - "mcp__penumbra__chain.list_agents"     # exact match
        - "fs.readTextFile"
```

(Deliberately narrow — `mcp__sirius__*` will be off-list for Smoke B/C/D/E.)

- [ ] **Step 3: Reload daemon config**

```
mcp__penumbra__daemon_reload_config({})
```

**Smoke A — Allowlist auto-approve:**

- [ ] **Step 4: Tool ON allowlist → auto-approve, dispatch completes**

```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Use the penumbra MCP server to call chain.list_agents and reply EXACTLY: AGENTS: <number>',
  use_worktree: true,
  trust_mode: 'config'
})
```

Expected: response `AGENTS: 51` (matching the existing fleet count). Verify NO permission_requests row was created (would short-circuit by allowlist).

```
mcp__penumbra__permission_list_pending({ conversation_id: '<the-conv-id>' })
```

Expected: empty.

**Smoke B — Off-list operator approves:**

- [ ] **Step 5: Tool OFF allowlist → operator approves**

Start a chain that asks for an off-list tool (e.g., `mcp__sirius__sirius_chat`, which we can register as a side-effect MCP). Easier: test against a tool we DO have access to but didn't allowlist, like `mcp__penumbra__memory.recall`:

```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Use the penumbra MCP server to call memory.recall with query "hello" and limit 1, then reply EXACTLY: RECALLED: ok',
  use_worktree: true,
  trust_mode: 'config'
})
```

Within ~10 seconds:

```
mcp__penumbra__permission_list_pending({ conversation_id: '<the-conv-id>' })
```

Expected: a pending row with `tool_name: 'mcp__penumbra__memory.recall'`. Capture its `permission_id`.

Approve it:

```
mcp__penumbra__permission_approve({
  permission_id: '<the-permission-id>',
  decision: 'approve'
})
```

Expected: `status: 'approved'`. The dispatch resumes and completes with `RECALLED: ok`.

**Smoke C — Off-list operator rejects:**

- [ ] **Step 6: Same as Smoke B but reject**

Start identical chain. When the pending row appears:

```
mcp__penumbra__permission_approve({
  permission_id: '<the-permission-id>',
  decision: 'reject',
  reason: 'smoke-test reject path'
})
```

Expected: agent surfaces "permission denied" / "could not call tool", dispatch terminates without `RECALLED: ok`.

**Smoke D — TTL auto-reject:**

- [ ] **Step 7: Off-list, no operator action, TTL fires**

Start identical chain. **Do NOT call `permission_approve`.** Wait 15 seconds (TTL was set to 10s in Step 1).

Verify the row transitioned:

```
mcp__penumbra__permission_get({ permission_id: '<the-permission-id>' })
```

Expected: `status: 'expired'`. The dispatch terminated because the adapter received reject (callback Promise was rejected by `permission.expired` SSE event).

**Smoke E — Per-dispatch remember:**

- [ ] **Step 8: Off-list with `remember='this_dispatch'`**

Start a chain that calls the same off-list tool TWICE in a row:

```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Use the penumbra MCP server to call memory.recall with query "first" then memory.recall with query "second". Reply EXACTLY: BOTH: done',
  use_worktree: true,
  trust_mode: 'config'
})
```

When the FIRST pending row appears, approve with `remember='this_dispatch'`:

```
mcp__penumbra__permission_approve({
  permission_id: '<first-permission-id>',
  decision: 'approve',
  remember: 'this_dispatch'
})
```

Expected: dispatch completes with `BOTH: done`. Verify NO second permission_requests row was created (the per-dispatch cache short-circuited the second call):

```
mcp__penumbra__permission_list_pending({ conversation_id: '<the-conv-id>', status: 'pending,approved,rejected,expired' })
```

Expected: exactly ONE row, status `approved`, `remember_scope: 'this_dispatch'`.

**Wrap-up:**

- [ ] **Step 9: Append outcomes to the agent-performance ledger**

Five rows in `docs/superpowers/notes/agent-performance.md`:
- Smoke A merged (allowlist auto-approve)
- Smoke B merged (operator approve)
- Smoke C merged (operator reject)
- Smoke D merged (TTL auto-reject)
- Smoke E merged (per-dispatch remember short-circuit)

If any smoke fails, do NOT iterate — stop, surface the failure, capture logs from `/tmp/worker-*.log`, and decide whether to fix forward or revert. The discipline rule against fix-loops applies (`feedback_sequential_rollout_no_dispatch_loops`).

---

## Verification — does the plan cover the spec?

| Spec section | Tasks |
|---|---|
| Architecture overview (request flow) | Tasks 17, 19, 20, 21 |
| Schema — permission_requests table | Task 3 |
| Schema — zod schemas | Task 1 |
| Schema — EventTypeSchema extension | Task 2 |
| PermissionWriter (create + decide CAS + expirePastDue) | Task 4 |
| PermissionReader (get + listByStatus) | Task 5 |
| Services wiring + exports | Task 7 |
| PermissionEventBus (in-process emitter + ring buffer) | Task 6 |
| `POST /permissions` (idempotent on permission_id) | Task 8 |
| `GET /permissions/:id` | Task 9 |
| `GET /permissions` (filter matrix) | Task 9 |
| `POST /permissions/:id/decide` (atomic CAS, 409 conflict, audit) | Task 10 |
| SSE `GET /permissions/events` (ring-buffer Last-Event-ID replay) | Task 11 |
| TTL sweeper | Task 12 |
| Daemon serve.ts wiring | Task 13 |
| PenumbraClient permission methods (worker-side HTTP) | Task 14 |
| PermissionDaemonClient (SSE consumer + waiter map + register-before-POST) | Task 15 |
| Allowlist matcher (exact ∪ glob ∪ per-dispatch cache) | Task 16 |
| createPermissionCallback v2 form | Task 17 |
| Yaml `allowed_tools` + `permission_ttl_s` | Task 18 |
| agentchat-worker.ts — boot daemon client + per-dispatch wiring | Task 19 |
| stdio-acp tool-name extraction guard | Task 20 |
| Three MCP tools + daemon-client methods + server registration | Task 21 |
| Audit trail (3 t0 event types: requested/decided/expired) | Tasks 8, 10, 12 |
| Error handling matrix (HTTP failure ⇒ reject, SSE reconnect, race-free registration, TTL on dead-worker rows) | Tasks 14, 15, 12, 11 |
| Integration smoke (5 scenarios A–E) | Task 23 |

All spec items mapped. The Phase 1d implications section in the spec is a forward-looking note, not an implementation requirement — no task needed here.

---

## Estimated effort

- Tasks 1–7 (core schemas + writer + reader + bus + Services wiring): ~0.75 day
- Tasks 8–13 (daemon routes + SSE + sweeper + serve wiring): ~1 day
- Tasks 14–15 (worker HTTP/SSE plumbing): ~0.5 day
- Tasks 16–17 (allowlist matcher + v2 callback): ~0.25 day
- Tasks 18–20 (yaml + worker wiring + adapter guard): ~0.5 day
- Task 21 (MCP tools + daemon client + server reg): ~0.5 day
- Task 22 (suite green): ~0.25 day buffer
- Task 23 (maestro smoke): ~0.5 day

Total: ~4.25 days implementer + maestro. Matches the spec's ~4-day estimate.
