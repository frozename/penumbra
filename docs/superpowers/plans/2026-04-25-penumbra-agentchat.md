# Penumbra `agentchat` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a cross-agent group-chat orchestrator (`@penumbra/agentchat`) that lets Claude/Gemini/Codex/local LLMs talk to each other through penumbra, with the human gating handoffs via `@mention` approval.

**Architecture:** A new package `packages/agentchat` hosts a long-lived CLI that owns the conversation. It uses penumbra (existing daemon at `127.0.0.1:<port>`) for observation, recall, and a new mutable `handoffs` queue. Agents are abstracted behind an `Adapter` SDK; v1 ships four reference adapters (`claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`). Penumbra grows minimally: a new `event_type`, a new mutable table, three HTTP endpoints, two MCP tools.

**Tech Stack:** Bun + TypeScript (matches existing penumbra packages). zod for validation. `bun:sqlite` for the new table. Bun.spawn for CLI adapters. `bun:test` for tests. YAML for config (using a small parser — `js-yaml` is the convention in the user's other repos).

---

## File Structure

### Penumbra side (modifications + new files)

| path | role | new? |
|---|---|---|
| `packages/core/src/schemas/event.ts` | add `'agent-handoff'` to `EventTypeSchema` | mod |
| `packages/core/src/schemas/handoff.ts` | zod schemas for the queue row + request bodies | new |
| `packages/core/src/db/schema.ts` | add `handoffs` table CREATE statement | mod |
| `packages/core/src/writers/handoff.ts` | `HandoffWriter` (atomic insert + approve transition) | new |
| `packages/core/src/readers/handoff.ts` | `HandoffReader` (`listPending`, `get`) | new |
| `packages/core/src/index.ts` | re-export new types and classes | mod |
| `packages/daemon/src/routes/handoffs.ts` | `POST /handoffs`, `GET /handoffs/pending`, `POST /handoffs/:id/approve` | new |
| `packages/daemon/src/serve.ts` | wire the three new routes | mod |
| `packages/mcp/src/tools/handoff-list.ts` | MCP `handoff.list_pending` tool | new |
| `packages/mcp/src/tools/handoff-approve.ts` | MCP `handoff.approve` tool | new |
| `packages/mcp/src/server.ts` | register the two new MCP tools | mod |
| `packages/mcp/src/daemon-client.ts` | add `listPendingHandoffs`, `approveHandoff` methods | mod |

Tests for each in the corresponding `test/` directory following existing patterns (`packages/core/test/`, `packages/daemon/test/`, `packages/mcp/test/`).

### `agentchat` package (all new)

| path | role |
|---|---|
| `packages/agentchat/package.json` | workspace package manifest |
| `packages/agentchat/tsconfig.json` | TS config |
| `packages/agentchat/bin/agentchat.ts` | CLI dispatcher binary |
| `packages/agentchat/src/index.ts` | public re-exports |
| `packages/agentchat/src/sdk/adapter.ts` | `Adapter`, `DispatchInput`, `DispatchOutput`, `DispatchEvent` types |
| `packages/agentchat/src/sdk/stream-wrapper.ts` | wraps non-streaming `dispatch` into a single `delta + done` AsyncIterable |
| `packages/agentchat/src/config/types.ts` | `AgentConfig`, `AgentChatConfig` types |
| `packages/agentchat/src/config/load.ts` | YAML loader → validated config |
| `packages/agentchat/src/mention/parser.ts` | extract `@target` tokens from agent text |
| `packages/agentchat/src/mention/resolver.ts` | role-first/name-fallback resolution against config |
| `packages/agentchat/src/penumbra-client.ts` | HTTP client to the penumbra daemon (lazy port/token resolver) |
| `packages/agentchat/src/transcript-slice.ts` | bundle the next agent's prompt: project context + handoff message + recent transcript |
| `packages/agentchat/src/adapters/cli-spawn.ts` | shared subprocess helper for CLI adapters |
| `packages/agentchat/src/adapters/openai-compat-http.ts` | first reference adapter (HTTP, smallest) |
| `packages/agentchat/src/adapters/claude-cli.ts` | claude CLI adapter |
| `packages/agentchat/src/adapters/gemini-cli.ts` | gemini CLI adapter |
| `packages/agentchat/src/adapters/codex-cli.ts` | codex CLI adapter |
| `packages/agentchat/src/adapters/registry.ts` | maps `kind: string` → adapter constructor |
| `packages/agentchat/src/dispatcher.ts` | given a pending handoff, resolves agent, builds prompt, calls adapter, observes the response, parses next `@mention` |
| `packages/agentchat/src/cli/loop.ts` | the long-lived chat loop |
| `packages/agentchat/src/cli/inline-approval.ts` | the inline `[handoff …]` prompt and key handler |
| `packages/agentchat/src/cli/queue.ts` | `agentchat queue` command |
| `packages/agentchat/src/cli/approve.ts` | `agentchat approve` / `reject` commands |
| `packages/agentchat/test/...` | mirror tree |

### Workspace integration

| path | role |
|---|---|
| `package.json` (root) | the existing `"workspaces": ["packages/*", "packages/integrations/*"]` glob already picks up `packages/agentchat` — no edit needed |

---

## Milestone 1 — End-to-End Slice (penumbra schema + agentchat skeleton + one adapter + inline approval + e2e)

After Milestone 1, a real handoff works end-to-end against an OpenAI-compatible HTTP target.

### Task 1: Add `'agent-handoff'` to `EventTypeSchema`

**Files:**
- Modify: `packages/core/src/schemas/event.ts:6-12`
- Test: `packages/core/test/schemas/event.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/schemas/event.test.ts
import { expect, test } from 'bun:test';
import { EventTypeSchema } from '../../src/schemas/event.js';

test("EventTypeSchema accepts 'agent-handoff'", () => {
  expect(EventTypeSchema.safeParse('agent-handoff').success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/schemas/event.test.ts`
Expected: FAIL — `'agent-handoff'` rejected by enum.

- [ ] **Step 3: Add the value to the enum**

Edit `packages/core/src/schemas/event.ts:6-12`:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt',
  'agent-tool-use',
  'agent-response',
  'agent-handoff',
  'request',
  'response',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test test/schemas/event.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite to verify no regression**

Run: `cd /Volumes/WorkSSD/repos/personal/penumbra && bun test`
Expected: previous pass count + 1, no failures.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas/event.ts packages/core/test/schemas/event.test.ts
git commit -m "feat(core): add 'agent-handoff' to EventTypeSchema for cross-agent orchestration"
```

---

### Task 2: Add `handoff` zod schemas

**Files:**
- Create: `packages/core/src/schemas/handoff.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: `packages/core/test/schemas/handoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/schemas/handoff.test.ts
import { expect, test } from 'bun:test';
import {
  HandoffStatusSchema,
  HandoffRowSchema,
  CreateHandoffRequestSchema,
  ApproveHandoffRequestSchema,
} from '../../src/schemas/handoff.js';

test('HandoffStatusSchema accepts valid statuses', () => {
  for (const s of ['pending', 'approved', 'redirected', 'rejected', 'dispatched', 'completed']) {
    expect(HandoffStatusSchema.safeParse(s).success).toBe(true);
  }
  expect(HandoffStatusSchema.safeParse('unknown').success).toBe(false);
});

test('HandoffRowSchema validates a complete row', () => {
  const row = {
    handoff_id: 'h-1',
    ts: '2026-04-25T20:00:00.000Z',
    project_id: 'auth-svc',
    conversation_id: 'conv-7',
    from_agent: 'claude',
    to_agent: 'gemini',
    to_role: 'executor',
    message: 'Run the plan',
    status: 'pending',
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    triggered_by_event_id: 'evt-42',
  };
  expect(HandoffRowSchema.safeParse(row).success).toBe(true);
});

test('CreateHandoffRequestSchema requires from/to/message/conversation_id/triggered_by_event_id', () => {
  expect(CreateHandoffRequestSchema.safeParse({
    from: 'claude', to: 'gemini', message: 'go', conversation_id: 'c',
    triggered_by_event_id: 'e',
  }).success).toBe(true);
  expect(CreateHandoffRequestSchema.safeParse({
    from: 'claude', to: 'gemini',
  }).success).toBe(false);
});

test('ApproveHandoffRequestSchema accepts plain, redirect, reject', () => {
  expect(ApproveHandoffRequestSchema.safeParse({}).success).toBe(true);
  expect(ApproveHandoffRequestSchema.safeParse({ redirect_to: 'codex' }).success).toBe(true);
  expect(ApproveHandoffRequestSchema.safeParse({ reject: true, reason: 'dup' }).success).toBe(true);
  expect(ApproveHandoffRequestSchema.safeParse({ redirect_to: 'codex', reject: true }).success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/schemas/handoff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the schema file**

```ts
// packages/core/src/schemas/handoff.ts
import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const HandoffStatusSchema = z.enum([
  'pending',
  'approved',
  'redirected',
  'rejected',
  'dispatched',
  'completed',
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const HandoffRowSchema = z.object({
  handoff_id: z.string(),
  ts: z.string(),
  project_id: SafeProjectIdSchema.nullable(),
  conversation_id: z.string(),
  from_agent: z.string(),
  to_agent: z.string(),
  to_role: z.string().nullable(),
  message: z.string(),
  status: HandoffStatusSchema,
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  redirected_to: z.string().nullable(),
  triggered_by_event_id: z.string().nullable(),
});
export type HandoffRow = z.infer<typeof HandoffRowSchema>;

export const CreateHandoffRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  to_role: z.string().nullable().optional(),
  message: z.string().min(1),
  conversation_id: z.string().min(1),
  project_id: SafeProjectIdSchema.nullable().optional(),
  triggered_by_event_id: z.string().min(1),
});
export type CreateHandoffRequest = z.infer<typeof CreateHandoffRequestSchema>;

export const ApproveHandoffRequestSchema = z
  .object({
    redirect_to: z.string().min(1).optional(),
    reject: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .refine(
    (v) => !(v.redirect_to && v.reject === true),
    { message: 'redirect_to and reject are mutually exclusive' },
  );
export type ApproveHandoffRequest = z.infer<typeof ApproveHandoffRequestSchema>;
```

- [ ] **Step 4: Re-export from core's index**

Edit `packages/core/src/index.ts`, add at the end of the schema re-exports:

```ts
export {
  HandoffStatusSchema,
  HandoffRowSchema,
  CreateHandoffRequestSchema,
  ApproveHandoffRequestSchema,
  type HandoffStatus,
  type HandoffRow,
  type CreateHandoffRequest,
  type ApproveHandoffRequest,
} from './schemas/handoff.js';
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/core && bun test test/schemas/handoff.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas/handoff.ts packages/core/src/index.ts packages/core/test/schemas/handoff.test.ts
git commit -m "feat(core): add zod schemas for handoff queue rows and request bodies"
```

---

### Task 3: Add `handoffs` table to DB schema

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Test: `packages/core/test/db/schema.test.ts` (create or extend)

- [ ] **Step 1: Locate the existing CREATE block for `t1_rollups`**

Run: `grep -n "t1_rollups" packages/core/src/db/schema.ts`
Note the line number where the table is created.

- [ ] **Step 2: Write the failing test**

```ts
// packages/core/test/db/schema.test.ts (add this test if file exists)
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../src/db/schema.js';

test('applySchema creates handoffs table with status index', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'",
  ).all();
  expect(tables.length).toBe(1);

  const indexes = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='handoffs'",
  ).all().map((r) => r.name);
  expect(indexes).toContain('handoffs_pending');
  expect(indexes).toContain('handoffs_by_conv');

  db.close();
});
```

If `packages/core/test/db/schema.test.ts` does not exist yet, create it with the import header and just this one test.

- [ ] **Step 3: Run, expect fail**

Run: `cd packages/core && bun test test/db/schema.test.ts`
Expected: FAIL — table does not exist.

- [ ] **Step 4: Add the CREATE TABLE statement to `db/schema.ts`**

Locate the function that runs migrations / CREATE TABLE statements (likely a `applySchema` or similar function in `packages/core/src/db/schema.ts`). Append after the `t2_memories` block:

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS handoffs (
    handoff_id              TEXT PRIMARY KEY,
    ts                      TEXT NOT NULL,
    project_id              TEXT,
    conversation_id         TEXT NOT NULL,
    from_agent              TEXT NOT NULL,
    to_agent                TEXT NOT NULL,
    to_role                 TEXT,
    message                 TEXT NOT NULL,
    status                  TEXT NOT NULL,
    resolved_by             TEXT,
    resolved_at             TEXT,
    redirected_to           TEXT,
    triggered_by_event_id   TEXT
  );
  CREATE INDEX IF NOT EXISTS handoffs_pending ON handoffs(status, ts) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS handoffs_by_conv ON handoffs(conversation_id, ts);
`);
```

- [ ] **Step 5: Run test, expect pass**

Run: `cd packages/core && bun test test/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full core suite**

Run: `cd packages/core && bun test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/schema.test.ts
git commit -m "feat(core): add handoffs queue table for cross-agent orchestration"
```

---

### Task 4: `HandoffWriter` — insert + transition

**Files:**
- Create: `packages/core/src/writers/handoff.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: `packages/core/test/writers/handoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/writers/handoff.test.ts
import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../src/db/schema.js';
import { HandoffWriter } from '../../src/writers/handoff.js';

let db: Database;
let writer: HandoffWriter;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  writer = new HandoffWriter({ db });
});

test('create() inserts a pending handoff with the given handoff_id', () => {
  const id = writer.create({
    handoff_id: 'h-1',
    ts: '2026-04-25T20:00:00.000Z',
    from_agent: 'claude',
    to_agent: 'gemini',
    to_role: 'executor',
    message: 'go',
    conversation_id: 'conv-7',
    project_id: 'auth-svc',
    triggered_by_event_id: 'evt-1',
  });
  expect(id).toBe('h-1');
  const row = db.query<{ status: string; from_agent: string }, [string]>(
    'SELECT status, from_agent FROM handoffs WHERE handoff_id=?',
  ).get('h-1');
  expect(row?.status).toBe('pending');
  expect(row?.from_agent).toBe('claude');
});

test('approve() transitions pending → approved and records actor + ts', () => {
  writer.create({
    handoff_id: 'h-2', ts: 't', from_agent: 'a', to_agent: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  });
  const result = writer.approve('h-2', { resolved_by: 'user', resolved_at: '2026-04-25T20:01:00Z' });
  expect(result.status).toBe('approved');
  const row = db.query<{ status: string; resolved_by: string | null }, [string]>(
    'SELECT status, resolved_by FROM handoffs WHERE handoff_id=?',
  ).get('h-2');
  expect(row?.status).toBe('approved');
  expect(row?.resolved_by).toBe('user');
});

test('approve() with redirect_to records redirected status and target', () => {
  writer.create({
    handoff_id: 'h-3', ts: 't', from_agent: 'a', to_agent: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  });
  const result = writer.approve('h-3', { resolved_by: 'user', resolved_at: 't2', redirect_to: 'codex' });
  expect(result.status).toBe('redirected');
  expect(result.redirected_to).toBe('codex');
});

test('approve() rejects an already-resolved handoff with conflict', () => {
  writer.create({
    handoff_id: 'h-4', ts: 't', from_agent: 'a', to_agent: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  });
  writer.approve('h-4', { resolved_by: 'user', resolved_at: 't' });
  expect(() => writer.approve('h-4', { resolved_by: 'user', resolved_at: 't' }))
    .toThrow(/conflict/);
});

test('claimDispatch() flips approved → dispatched atomically; only one wins', () => {
  writer.create({
    handoff_id: 'h-5', ts: 't', from_agent: 'a', to_agent: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  });
  writer.approve('h-5', { resolved_by: 'u', resolved_at: 't' });
  expect(writer.claimDispatch('h-5')).toBe(true);
  expect(writer.claimDispatch('h-5')).toBe(false); // already dispatched
});

test('markCompleted() transitions dispatched → completed', () => {
  writer.create({
    handoff_id: 'h-6', ts: 't', from_agent: 'a', to_agent: 'b', to_role: null,
    message: 'm', conversation_id: 'c', project_id: null, triggered_by_event_id: 'e',
  });
  writer.approve('h-6', { resolved_by: 'u', resolved_at: 't' });
  writer.claimDispatch('h-6');
  writer.markCompleted('h-6');
  const row = db.query<{ status: string }, [string]>(
    'SELECT status FROM handoffs WHERE handoff_id=?',
  ).get('h-6');
  expect(row?.status).toBe('completed');
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/core && bun test test/writers/handoff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the writer**

```ts
// packages/core/src/writers/handoff.ts
import type { Database } from 'bun:sqlite';
import type { CreateHandoffRequest } from '../schemas/handoff.js';

export interface HandoffWriterOpts { db: Database }

export interface CreateHandoffParams extends CreateHandoffRequest {
  handoff_id: string;
  ts: string;
}

export interface ApproveOpts {
  resolved_by: string;
  resolved_at: string;
  redirect_to?: string;
}

export interface ApproveResult {
  status: 'approved' | 'redirected' | 'rejected';
  redirected_to: string | null;
}

export class HandoffWriter {
  private readonly db: Database;
  constructor(opts: HandoffWriterOpts) {
    this.db = opts.db;
  }

  create(params: CreateHandoffParams): string {
    this.db
      .query<unknown, [string, string, string | null, string, string, string, string | null, string, string, string | null]>(
        `INSERT INTO handoffs (
          handoff_id, ts, project_id, conversation_id,
          from_agent, to_agent, to_role, message, status, triggered_by_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        params.handoff_id, params.ts, params.project_id ?? null,
        params.conversation_id, params.from, params.to, params.to_role ?? null,
        params.message, params.triggered_by_event_id,
      );
    return params.handoff_id;
  }

  approve(handoff_id: string, opts: ApproveOpts): ApproveResult {
    const status = opts.redirect_to ? 'redirected' : 'approved';
    const redirected_to = opts.redirect_to ?? null;
    const changes = this.db
      .query<unknown, [string, string, string, string | null, string]>(
        `UPDATE handoffs
            SET status=?, resolved_by=?, resolved_at=?, redirected_to=?
          WHERE handoff_id=? AND status='pending'`,
      )
      .run(status, opts.resolved_by, opts.resolved_at, redirected_to, handoff_id);
    if (changes.changes === 0) {
      throw new Error(`conflict: handoff ${handoff_id} is not pending`);
    }
    return { status, redirected_to };
  }

  reject(handoff_id: string, opts: { resolved_by: string; resolved_at: string; reason?: string }): void {
    const changes = this.db
      .query<unknown, [string, string, string]>(
        `UPDATE handoffs SET status='rejected', resolved_by=?, resolved_at=? WHERE handoff_id=? AND status='pending'`,
      )
      .run(opts.resolved_by, opts.resolved_at, handoff_id);
    if (changes.changes === 0) {
      throw new Error(`conflict: handoff ${handoff_id} is not pending`);
    }
  }

  /** Atomically claim approved → dispatched. Returns true if this caller won. */
  claimDispatch(handoff_id: string): boolean {
    const changes = this.db
      .query<unknown, [string]>(
        `UPDATE handoffs SET status='dispatched' WHERE handoff_id=? AND status IN ('approved','redirected')`,
      )
      .run(handoff_id);
    return changes.changes > 0;
  }

  markCompleted(handoff_id: string): void {
    this.db
      .query<unknown, [string]>(
        `UPDATE handoffs SET status='completed' WHERE handoff_id=? AND status='dispatched'`,
      )
      .run(handoff_id);
  }
}
```

- [ ] **Step 4: Re-export**

Add to `packages/core/src/index.ts`:

```ts
export { HandoffWriter, type CreateHandoffParams, type ApproveOpts, type ApproveResult } from './writers/handoff.js';
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/core && bun test test/writers/handoff.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/writers/handoff.ts packages/core/src/index.ts packages/core/test/writers/handoff.test.ts
git commit -m "feat(core): HandoffWriter — atomic queue transitions for cross-agent handoffs"
```

---

### Task 5: `HandoffReader` — listPending + get

**Files:**
- Create: `packages/core/src/readers/handoff.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/readers/handoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/readers/handoff.test.ts
import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../src/db/schema.js';
import { HandoffWriter } from '../../src/writers/handoff.js';
import { HandoffReader } from '../../src/readers/handoff.js';

let db: Database;
let reader: HandoffReader;
let writer: HandoffWriter;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  writer = new HandoffWriter({ db });
  reader = new HandoffReader({ db });
});

const sampleParams = (id: string, conv: string) => ({
  handoff_id: id, ts: `2026-04-25T20:00:0${id.slice(-1)}.000Z`,
  from: 'claude', to: 'gemini', to_role: null,
  message: `m-${id}`, conversation_id: conv, project_id: null,
  triggered_by_event_id: `e-${id}`,
});

test('listPending returns only pending handoffs, oldest first', () => {
  writer.create(sampleParams('h-1', 'c-a'));
  writer.create(sampleParams('h-2', 'c-a'));
  writer.create(sampleParams('h-3', 'c-b'));
  writer.approve('h-2', { resolved_by: 'u', resolved_at: 't' });

  const all = reader.listPending();
  expect(all.map((h) => h.handoff_id)).toEqual(['h-1', 'h-3']);
});

test('listPending filters by conversation_id when provided', () => {
  writer.create(sampleParams('h-1', 'c-a'));
  writer.create(sampleParams('h-2', 'c-b'));

  const inA = reader.listPending({ conversation_id: 'c-a' });
  expect(inA.map((h) => h.handoff_id)).toEqual(['h-1']);
});

test('get returns the row by id, or null', () => {
  writer.create(sampleParams('h-1', 'c-a'));
  expect(reader.get('h-1')?.handoff_id).toBe('h-1');
  expect(reader.get('missing')).toBeNull();
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/core && bun test test/readers/handoff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reader**

```ts
// packages/core/src/readers/handoff.ts
import type { Database } from 'bun:sqlite';
import type { HandoffRow } from '../schemas/handoff.js';

export interface HandoffReaderOpts { db: Database }

export class HandoffReader {
  private readonly db: Database;
  constructor(opts: HandoffReaderOpts) { this.db = opts.db; }

  listPending(opts?: { conversation_id?: string }): HandoffRow[] {
    if (opts?.conversation_id) {
      return this.db
        .query<HandoffRow, [string]>(
          `SELECT * FROM handoffs WHERE status='pending' AND conversation_id=? ORDER BY ts ASC`,
        )
        .all(opts.conversation_id);
    }
    return this.db
      .query<HandoffRow, []>(
        `SELECT * FROM handoffs WHERE status='pending' ORDER BY ts ASC`,
      )
      .all();
  }

  get(handoff_id: string): HandoffRow | null {
    const row = this.db
      .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
      .get(handoff_id);
    return row ?? null;
  }
}
```

- [ ] **Step 4: Re-export**

Add to `packages/core/src/index.ts`:

```ts
export { HandoffReader, type HandoffReaderOpts } from './readers/handoff.js';
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/core && bun test test/readers/handoff.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/readers/handoff.ts packages/core/src/index.ts packages/core/test/readers/handoff.test.ts
git commit -m "feat(core): HandoffReader — listPending + get for cross-agent queue"
```

---

### Task 6: Daemon route — `POST /handoffs` (atomic t0 + queue write)

**Files:**
- Create: `packages/daemon/src/routes/handoffs.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/handoffs.test.ts`

- [ ] **Step 1: Inspect how `observations.ts` builds Services + writes events**

Run: `cat packages/daemon/src/routes/observations.ts`
Note: how `services.t0Writer.write(event)` is called and how validation errors are returned.

- [ ] **Step 2: Write the failing test for POST /handoffs**

```ts
// packages/daemon/test/routes/handoffs.test.ts
import { expect, test } from 'bun:test';
import { handoffsCreateRoute } from '../../src/routes/handoffs.js';
import type { Services } from '@penumbra/core';
import { Database } from 'bun:sqlite';
import { applySchema, HandoffWriter, HandoffReader } from '@penumbra/core';

function makeServices(db: Database): Services {
  // Build a minimal Services bundle for tests. The exact shape is whatever
  // packages/core's Services interface requires — see existing test helpers.
  // For unit-level routes, a stub with the bits the route uses is sufficient.
  const writer = new HandoffWriter({ db });
  const reader = new HandoffReader({ db });
  return {
    db,
    handoffWriter: writer,
    handoffReader: reader,
    machineId: { get: () => 'machine-test' },
    uuid: () => 'evt-fixed-1',
    clock: () => new Date('2026-04-25T20:00:00.000Z'),
    t0Writer: { write: () => {} },
    redactor: { redact: (s: unknown) => s },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

test('POST /handoffs creates a pending handoff and returns the id', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const services = makeServices(db);

  const req = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude',
      to: 'gemini',
      to_role: 'executor',
      message: 'go',
      conversation_id: 'conv-7',
      project_id: 'auth-svc',
      triggered_by_event_id: 'evt-source-1',
    }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('pending');
  expect(typeof body.handoff_id).toBe('string');

  const row = db.query<{ status: string }, [string]>(
    'SELECT status FROM handoffs WHERE handoff_id=?',
  ).get(body.handoff_id);
  expect(row?.status).toBe('pending');
});

test('POST /handoffs returns 400 for invalid body', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const services = makeServices(db);
  const req = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({ from: 'claude' }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(400);
});
```

- [ ] **Step 3: Run, expect fail**

Run: `cd packages/daemon && bun test test/routes/handoffs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the route**

```ts
// packages/daemon/src/routes/handoffs.ts
import type { Services } from '@penumbra/core';
import { CreateHandoffRequestSchema, ApproveHandoffRequestSchema } from '@penumbra/core';

export async function handoffsCreateRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const parsed = CreateHandoffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();

  // Single transaction: write t0 'agent-handoff' event AND the handoffs row.
  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: handoff_id,
      ts,
      ingest_ts: ts,
      source: 'mcp',  // recorded as a system-internal handoff
      source_detail: 'agent-handoff',
      project_id: parsed.data.project_id ?? null,
      user_id: parsed.data.from,
      machine_id: services.machineId.get(),
      session_id: parsed.data.conversation_id,
      event_type: 'agent-handoff',
      lane: 'unknown',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: {
        from: parsed.data.from,
        to: parsed.data.to,
        mentioned_as: parsed.data.to_role ? 'role' : 'name',
        message_excerpt: parsed.data.message.slice(0, 240),
        triggered_by_event_id: parsed.data.triggered_by_event_id,
      },
      payload_summary: parsed.data.message.slice(0, 240),
    });

    services.handoffWriter.create({
      handoff_id, ts,
      from: parsed.data.from,
      to: parsed.data.to,
      to_role: parsed.data.to_role ?? null,
      message: parsed.data.message,
      conversation_id: parsed.data.conversation_id,
      project_id: parsed.data.project_id ?? null,
      triggered_by_event_id: parsed.data.triggered_by_event_id,
    });
  })();

  return json({ handoff_id, status: 'pending' });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
```

- [ ] **Step 5: Wire `handoffWriter` and `handoffReader` into `Services`**

In `packages/core/src/services.ts` (or wherever `Services` is built — search for `t0Writer`):

```ts
// Add fields:
//   handoffWriter: HandoffWriter
//   handoffReader: HandoffReader
// And construct them in the same place t0Writer is built.
```

Add unit test in core for `buildServices` that asserts the new fields exist.

- [ ] **Step 6: Wire the route into `serve.ts`**

Edit `packages/daemon/src/serve.ts`, add to the dispatch chain after the existing POST handlers:

```ts
import { handoffsCreateRoute } from './routes/handoffs.js';
// ...
if (req.method === 'POST' && url.pathname === '/handoffs') {
  return handoffsCreateRoute(req, opts.services);
}
```

- [ ] **Step 7: Run all tests, expect pass**

Run: `cd /Volumes/WorkSSD/repos/personal/penumbra && bun test`
Expected: all green, new tests for /handoffs pass.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/routes/handoffs.ts packages/daemon/src/serve.ts \
        packages/daemon/test/routes/handoffs.test.ts \
        packages/core/src/services.ts
git commit -m "feat(daemon): POST /handoffs creates pending queue row + agent-handoff t0 event atomically"
```

---

### Task 7: Daemon routes — `GET /handoffs/pending` and `POST /handoffs/:id/approve`

**Files:**
- Modify: `packages/daemon/src/routes/handoffs.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/handoffs.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `packages/daemon/test/routes/handoffs.test.ts`:

```ts
import { handoffsListPendingRoute, handoffsApproveRoute } from '../../src/routes/handoffs.js';

test('GET /handoffs/pending returns pending handoffs', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const services = makeServices(db);
  // seed via the create route
  await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', message: 'go',
      conversation_id: 'c-1', triggered_by_event_id: 'e',
    }),
  }), services);

  const res = await handoffsListPendingRoute(
    new Request('http://x/handoffs/pending'), services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].status).toBe('pending');
});

test('POST /handoffs/:id/approve flips to approved', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', message: 'go',
      conversation_id: 'c-1', triggered_by_event_id: 'e',
    }),
  }), services)).json();
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, { method: 'POST', body: '{}' }),
    id, services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('approved');
});

test('POST /handoffs/:id/approve returns 409 if already resolved', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', message: 'go',
      conversation_id: 'c-1', triggered_by_event_id: 'e',
    }),
  }), services)).json();
  const id = create.handoff_id;

  await handoffsApproveRoute(new Request(`http://x/handoffs/${id}/approve`, {
    method: 'POST', body: '{}',
  }), id, services);
  const second = await handoffsApproveRoute(new Request(`http://x/handoffs/${id}/approve`, {
    method: 'POST', body: '{}',
  }), id, services);
  expect(second.status).toBe(409);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/daemon && bun test test/routes/handoffs.test.ts`
Expected: 3 fails (functions not exported).

- [ ] **Step 3: Add the two routes to `routes/handoffs.ts`**

Append to `packages/daemon/src/routes/handoffs.ts`:

```ts
export async function handoffsListPendingRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conv = url.searchParams.get('conversation_id') ?? undefined;
  const handoffs = services.handoffReader.listPending(conv ? { conversation_id: conv } : undefined);
  return json({ handoffs });
}

export async function handoffsApproveRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  const parsed = ApproveHandoffRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: { code: 'validation_error', field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    }, 400);
  }
  const ts = services.clock().toISOString();
  try {
    if (parsed.data.reject) {
      services.handoffWriter.reject(handoff_id, { resolved_by: services.machineId.get(), resolved_at: ts, reason: parsed.data.reason });
      return json({ handoff_id, status: 'rejected' });
    }
    const result = services.handoffWriter.approve(handoff_id, {
      resolved_by: services.machineId.get(),
      resolved_at: ts,
      redirect_to: parsed.data.redirect_to,
    });
    return json({ handoff_id, status: result.status, redirected_to: result.redirected_to });
  } catch (err) {
    const cur = services.handoffReader.get(handoff_id);
    if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
    return json({ error: { code: 'conflict', message: `handoff ${handoff_id} is ${cur.status}, not pending` }, current_status: cur.status }, 409);
  }
}
```

- [ ] **Step 4: Wire into `serve.ts`**

```ts
// In the dispatch chain, after POST /handoffs:
if (req.method === 'GET' && url.pathname === '/handoffs/pending') {
  return handoffsListPendingRoute(req, opts.services);
}
const approveMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/approve$/);
if (req.method === 'POST' && approveMatch) {
  return handoffsApproveRoute(req, approveMatch[1]!, opts.services);
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/daemon && bun test test/routes/handoffs.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/routes/handoffs.ts packages/daemon/src/serve.ts packages/daemon/test/routes/handoffs.test.ts
git commit -m "feat(daemon): GET /handoffs/pending and POST /handoffs/:id/approve with idempotent 409"
```

---

### Task 8: Scaffold `@penumbra/agentchat` package

**Files:**
- Create: `packages/agentchat/package.json`
- Create: `packages/agentchat/tsconfig.json`
- Create: `packages/agentchat/src/index.ts`
- Create: `packages/agentchat/test/smoke.test.ts`

- [ ] **Step 1: Inspect an existing package layout for reference**

Run: `cat packages/integrations/sirius-middleware/package.json packages/integrations/sirius-middleware/tsconfig.json`
Note the structure.

- [ ] **Step 2: Write package.json**

```json
{
  "name": "@penumbra/agentchat",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "bin": { "agentchat": "./bin/agentchat.ts" },
  "dependencies": {
    "@penumbra/core": "workspace:*",
    "js-yaml": "^4.1.0",
    "zod": "^4.3.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^25.6.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*", "bin/**/*", "test/**/*"]
}
```

- [ ] **Step 4: Smoke test the package is registered**

```ts
// packages/agentchat/test/smoke.test.ts
import { expect, test } from 'bun:test';

test('agentchat package smoke', () => {
  expect(true).toBe(true);
});
```

- [ ] **Step 5: Empty index for now**

```ts
// packages/agentchat/src/index.ts
export {};
```

- [ ] **Step 6: Install + run**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun install
cd packages/agentchat && bun test
```
Expected: 1 pass, dependency resolution clean.

- [ ] **Step 7: Run monorepo typecheck**

Run: `cd /Volumes/WorkSSD/repos/personal/penumbra && bun run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/agentchat/ bun.lock
git commit -m "feat(agentchat): scaffold @penumbra/agentchat package skeleton"
```

---

### Task 9: Adapter SDK types and stream wrapper

**Files:**
- Create: `packages/agentchat/src/sdk/adapter.ts`
- Create: `packages/agentchat/src/sdk/stream-wrapper.ts`
- Test: `packages/agentchat/test/sdk/stream-wrapper.test.ts`

- [ ] **Step 1: Write the SDK type file**

```ts
// packages/agentchat/src/sdk/adapter.ts
export interface DispatchInput {
  prompt: string;
  conversation: { id: string; project_id: string | null };
  config: Record<string, unknown>;
  signal: AbortSignal;
}

export interface DispatchOutput {
  text: string;
  meta?: {
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    raw_response?: unknown;
  };
}

export type DispatchEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: DispatchOutput };

export interface Adapter {
  readonly kind: string;
  dispatch(input: DispatchInput): Promise<DispatchOutput>;
  dispatchStream?(input: DispatchInput): AsyncIterable<DispatchEvent>;
  healthcheck?(): Promise<{ ok: boolean; detail?: string }>;
}
```

- [ ] **Step 2: Write the failing wrapper test**

```ts
// packages/agentchat/test/sdk/stream-wrapper.test.ts
import { expect, test } from 'bun:test';
import { ensureDispatchStream } from '../../src/sdk/stream-wrapper.js';
import type { Adapter } from '../../src/sdk/adapter.js';

test('ensureDispatchStream wraps non-streaming dispatch into a single delta + done', async () => {
  const adapter: Adapter = {
    kind: 'fake',
    async dispatch() { return { text: 'hello world' }; },
  };

  const stream = ensureDispatchStream(adapter, {
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {}, signal: new AbortController().signal,
  });

  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  expect(events).toEqual([
    { type: 'delta', text: 'hello world' },
    { type: 'done', result: { text: 'hello world' } },
  ]);
});

test('ensureDispatchStream passes through native dispatchStream when present', async () => {
  const adapter: Adapter = {
    kind: 'fake',
    async dispatch() { throw new Error('should not be called'); },
    async *dispatchStream() {
      yield { type: 'delta', text: 'hi ' } as const;
      yield { type: 'delta', text: 'there' } as const;
      yield { type: 'done', result: { text: 'hi there' } } as const;
    },
  };
  const events: any[] = [];
  for await (const ev of ensureDispatchStream(adapter, {
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {}, signal: new AbortController().signal,
  })) events.push(ev);
  expect(events.length).toBe(3);
  expect(events[0]).toEqual({ type: 'delta', text: 'hi ' });
});
```

- [ ] **Step 3: Run, expect fail**

Run: `cd packages/agentchat && bun test test/sdk/stream-wrapper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the wrapper**

```ts
// packages/agentchat/src/sdk/stream-wrapper.ts
import type { Adapter, DispatchEvent, DispatchInput } from './adapter.js';

export async function* ensureDispatchStream(
  adapter: Adapter,
  input: DispatchInput,
): AsyncIterable<DispatchEvent> {
  if (adapter.dispatchStream) {
    yield* adapter.dispatchStream(input);
    return;
  }
  const result = await adapter.dispatch(input);
  yield { type: 'delta', text: result.text };
  yield { type: 'done', result };
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/sdk/stream-wrapper.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/sdk/ packages/agentchat/test/sdk/
git commit -m "feat(agentchat): adapter SDK types + stream wrapper for non-streaming adapters"
```

---

### Task 10: Config types and YAML loader

**Files:**
- Create: `packages/agentchat/src/config/types.ts`
- Create: `packages/agentchat/src/config/load.ts`
- Test: `packages/agentchat/test/config/load.test.ts`

- [ ] **Step 1: Write the types**

```ts
// packages/agentchat/src/config/types.ts
import { z } from 'zod';

export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  adapter: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
  roles: z.array(z.string().min(1)).default([]),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentChatConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1),
  default_roles: z.record(z.string(), z.string()).default({}),
});
export type AgentChatConfig = z.infer<typeof AgentChatConfigSchema>;
```

- [ ] **Step 2: Write the failing loader test**

```ts
// packages/agentchat/test/config/load.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/load.js';

test('loadConfig parses a valid YAML config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `
agents:
  - name: claude
    adapter: claude-cli
    options: { command: claude }
    roles: [planner]
default_roles:
  planner: claude
`);
  const cfg = loadConfig(path);
  expect(cfg.agents.length).toBe(1);
  expect(cfg.agents[0]!.name).toBe('claude');
  expect(cfg.default_roles.planner).toBe('claude');
});

test('loadConfig throws on invalid shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentchat-cfg-'));
  const path = join(dir, 'agentchat.yaml');
  writeFileSync(path, `agents: []`);
  expect(() => loadConfig(path)).toThrow(/agents/);
});
```

- [ ] **Step 3: Run, expect fail**

Run: `cd packages/agentchat && bun test test/config/load.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the loader**

```ts
// packages/agentchat/src/config/load.ts
import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { AgentChatConfigSchema, type AgentChatConfig } from './types.js';

export function loadConfig(path: string): AgentChatConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  const result = AgentChatConfigSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`agentchat config invalid: ${message}`);
  }
  return result.data;
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/config/load.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/config/ packages/agentchat/test/config/
git commit -m "feat(agentchat): config schema + YAML loader"
```

---

### Task 11: Mention parser

**Files:**
- Create: `packages/agentchat/src/mention/parser.ts`
- Test: `packages/agentchat/test/mention/parser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agentchat/test/mention/parser.test.ts
import { expect, test } from 'bun:test';
import { parseMentions } from '../../src/mention/parser.js';

test('extracts a single @mention at the end of a message', () => {
  expect(parseMentions("Here's the plan. @gemini please run it."))
    .toEqual([{ target: 'gemini', span: { start: 19, end: 26 } }]);
});

test('extracts multiple @mentions', () => {
  expect(parseMentions('cc @gemini and @codex').map((m) => m.target))
    .toEqual(['gemini', 'codex']);
});

test('ignores @ inside an email or URL', () => {
  expect(parseMentions('contact alice@example.com or @bob'))
    .toEqual([{ target: 'bob', span: expect.any(Object) }]);
});

test('returns [] when there is no @mention', () => {
  expect(parseMentions('no targets here')).toEqual([]);
});

test('targets allow letters, digits, dashes, underscores', () => {
  expect(parseMentions('@local-llm and @gpt_4').map((m) => m.target))
    .toEqual(['local-llm', 'gpt_4']);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/mention/parser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the parser**

```ts
// packages/agentchat/src/mention/parser.ts
export interface Mention {
  target: string;
  span: { start: number; end: number };
}

const MENTION_RE = /(?<=^|\s)@([A-Za-z0-9_-]+)/g;

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    out.push({ target: m[1]!, span: { start, end: start + m[0].length } });
  }
  return out;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/mention/parser.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/mention/parser.ts packages/agentchat/test/mention/parser.test.ts
git commit -m "feat(agentchat): @mention parser with email/URL safety"
```

---

### Task 12: Mention resolver (role-first, name fallback)

**Files:**
- Create: `packages/agentchat/src/mention/resolver.ts`
- Test: `packages/agentchat/test/mention/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agentchat/test/mention/resolver.test.ts
import { expect, test } from 'bun:test';
import { resolveMention } from '../../src/mention/resolver.js';
import type { AgentChatConfig } from '../../src/config/types.js';

const cfg: AgentChatConfig = {
  agents: [
    { name: 'claude', adapter: 'cli', options: {}, roles: ['planner'] },
    { name: 'gemini', adapter: 'cli', options: {}, roles: ['executor'] },
    { name: 'codex',  adapter: 'cli', options: {}, roles: ['reviewer'] },
  ],
  default_roles: { planner: 'claude', executor: 'gemini', reviewer: 'codex' },
};

test('@<role> resolves via role binding', () => {
  expect(resolveMention('executor', cfg)).toEqual({ kind: 'role', agent_name: 'gemini', role: 'executor' });
});

test('@<name> resolves directly', () => {
  expect(resolveMention('codex', cfg)).toEqual({ kind: 'name', agent_name: 'codex' });
});

test('role wins over name when both could match', () => {
  // contrived: an agent named 'planner' AND a role 'planner'
  const conflicted: AgentChatConfig = {
    agents: [
      ...cfg.agents,
      { name: 'planner', adapter: 'cli', options: {}, roles: [] },
    ],
    default_roles: cfg.default_roles,
  };
  expect(resolveMention('planner', conflicted)).toEqual({
    kind: 'role', agent_name: 'claude', role: 'planner',
  });
});

test('unknown @<x> returns ambiguous', () => {
  expect(resolveMention('bob', cfg)).toEqual({ kind: 'unknown', target: 'bob' });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/mention/resolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the resolver**

```ts
// packages/agentchat/src/mention/resolver.ts
import type { AgentChatConfig } from '../config/types.js';

export type Resolution =
  | { kind: 'role'; agent_name: string; role: string }
  | { kind: 'name'; agent_name: string }
  | { kind: 'unknown'; target: string };

export function resolveMention(target: string, cfg: AgentChatConfig): Resolution {
  const roleBinding = cfg.default_roles[target];
  if (roleBinding) {
    const exists = cfg.agents.some((a) => a.name === roleBinding);
    if (exists) return { kind: 'role', agent_name: roleBinding, role: target };
  }
  const named = cfg.agents.find((a) => a.name === target);
  if (named) return { kind: 'name', agent_name: named.name };
  return { kind: 'unknown', target };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/mention/resolver.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/mention/resolver.ts packages/agentchat/test/mention/resolver.test.ts
git commit -m "feat(agentchat): mention resolver — role-first with name fallback"
```

---

### Task 13: Penumbra HTTP client (lazy port/token)

**Files:**
- Create: `packages/agentchat/src/penumbra-client.ts`
- Test: `packages/agentchat/test/penumbra-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agentchat/test/penumbra-client.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PenumbraClient } from '../src/penumbra-client.js';

test('observe POSTs /observations with bearer token', async () => {
  let received: { body: any; auth: string | null } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { body: await req.json(), auth: req.headers.get('authorization') };
      return Response.json({ event_id: 'e' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root });
  await client.observe({
    ts: '2026-04-25T20:00:00Z',
    source: 'mcp',
    event_type: 'agent-prompt',
    lane: 'unknown',
    payload_json: {},
    user_id: 'u', machine_id: 'm',
  });
  expect(received).not.toBeNull();
  expect(received!.auth).toBe('Bearer tk');
  server.stop(true);
});

test('createHandoff POSTs /handoffs and returns the new id', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ handoff_id: 'h-1', status: 'pending' }),
  });
  const root = mkdtempSync(join(tmpdir(), 'pen-client-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const client = new PenumbraClient({ storageRoot: root });
  const r = await client.createHandoff({
    from: 'claude', to: 'gemini', message: 'go',
    conversation_id: 'c-1', triggered_by_event_id: 'e-1',
  });
  expect(r.handoff_id).toBe('h-1');
  expect(r.status).toBe('pending');
  server.stop(true);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/penumbra-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the client**

```ts
// packages/agentchat/src/penumbra-client.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PenumbraClientOpts {
  storageRoot: string;
}

export class PenumbraClient {
  private readonly storageRoot: string;
  constructor(opts: PenumbraClientOpts) { this.storageRoot = opts.storageRoot; }

  async observe(event: Record<string, unknown>): Promise<{ event_id: string }> {
    return this.post('/observations', event);
  }
  async createHandoff(body: {
    from: string; to: string; to_role?: string | null; message: string;
    conversation_id: string; project_id?: string | null; triggered_by_event_id: string;
  }): Promise<{ handoff_id: string; status: string }> {
    return this.post('/handoffs', body);
  }
  async listPending(opts?: { conversation_id?: string }): Promise<{ handoffs: any[] }> {
    const qs = opts?.conversation_id ? `?conversation_id=${encodeURIComponent(opts.conversation_id)}` : '';
    return this.get(`/handoffs/pending${qs}`);
  }
  async approve(id: string, body: { redirect_to?: string; reject?: boolean; reason?: string } = {}): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/approve`, body);
  }

  private resolve(): { baseUrl: string; token: string } {
    const portPath = join(this.storageRoot, 'port');
    const tokenPath = join(this.storageRoot, 'token');
    if (!existsSync(portPath) || !existsSync(tokenPath)) {
      throw new Error(`penumbra not running at ${this.storageRoot} (missing port/token)`);
    }
    const port = Number(readFileSync(portPath, 'utf8').trim());
    const token = readFileSync(tokenPath, 'utf8').trim();
    return { baseUrl: `http://127.0.0.1:${port}`, token };
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`penumbra ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  private async get<T>(path: string): Promise<T> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`penumbra ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/penumbra-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/penumbra-client.ts packages/agentchat/test/penumbra-client.test.ts
git commit -m "feat(agentchat): penumbra HTTP client with lazy port/token resolution"
```

---

### Task 14: Transcript slice builder

**Files:**
- Create: `packages/agentchat/src/transcript-slice.ts`
- Test: `packages/agentchat/test/transcript-slice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agentchat/test/transcript-slice.test.ts
import { expect, test } from 'bun:test';
import { buildPrompt } from '../src/transcript-slice.js';

test('buildPrompt concatenates project context, handoff message, and recent responses', () => {
  const out = buildPrompt({
    projectContext: '# Project\nthe rate-limiter component',
    handoffMessage: '@executor please run the plan',
    recentResponses: [
      { agent: 'claude', text: "Here's the plan: 1) add middleware…" },
    ],
    tokenBudget: 4096,
  });
  expect(out).toContain('# Project');
  expect(out).toContain("Here's the plan");
  expect(out).toContain('@executor please run the plan');
  // handoff message must appear last (most recent context)
  expect(out.lastIndexOf('@executor')).toBeGreaterThan(out.lastIndexOf("Here's the plan"));
});

test('buildPrompt drops oldest responses when over the token budget', () => {
  const big = 'x'.repeat(4000);
  const out = buildPrompt({
    projectContext: '',
    handoffMessage: 'go',
    recentResponses: [
      { agent: 'a', text: big },
      { agent: 'b', text: big },
      { agent: 'c', text: 'recent' },
    ],
    tokenBudget: 1500, // ~6000 chars at 4 chars/token
  });
  expect(out).toContain('recent');
  expect(out).toContain('go');
  // expect the oldest to have been trimmed
  expect((out.match(/x{4000}/g) ?? []).length).toBeLessThan(2);
});

test('buildPrompt handles empty inputs gracefully', () => {
  const out = buildPrompt({
    projectContext: '',
    handoffMessage: '',
    recentResponses: [],
    tokenBudget: 1000,
  });
  expect(typeof out).toBe('string');
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/transcript-slice.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/agentchat/src/transcript-slice.ts
export interface RecentResponse { agent: string; text: string }

export interface BuildPromptInput {
  projectContext: string;
  handoffMessage: string;
  recentResponses: RecentResponse[];
  /** approximate budget in tokens (chars / 4 heuristic) */
  tokenBudget: number;
}

export function buildPrompt(input: BuildPromptInput): string {
  const charBudget = Math.max(0, input.tokenBudget * 4);
  const reserved =
    (input.projectContext ? input.projectContext.length + 4 : 0) +
    (input.handoffMessage ? input.handoffMessage.length + 4 : 0);
  let remaining = Math.max(0, charBudget - reserved);

  const tailBlocks: string[] = [];
  for (let i = input.recentResponses.length - 1; i >= 0; i--) {
    const r = input.recentResponses[i]!;
    const block = `## from ${r.agent}\n${r.text}`;
    if (block.length > remaining) break;
    tailBlocks.unshift(block);
    remaining -= block.length;
  }

  const parts: string[] = [];
  if (input.projectContext) parts.push(`## project context\n${input.projectContext}`);
  if (tailBlocks.length) parts.push(...tailBlocks);
  if (input.handoffMessage) parts.push(`## current message\n${input.handoffMessage}`);
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/transcript-slice.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/transcript-slice.ts packages/agentchat/test/transcript-slice.test.ts
git commit -m "feat(agentchat): transcript slice builder with token-budget eviction"
```

---

### Task 15: First adapter — `openai-compat-http`

**Files:**
- Create: `packages/agentchat/src/adapters/openai-compat-http.ts`
- Create: `packages/agentchat/src/adapters/registry.ts`
- Test: `packages/agentchat/test/adapters/openai-compat-http.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agentchat/test/adapters/openai-compat-http.test.ts
import { expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { OpenAiCompatHttpAdapter } from '../../src/adapters/openai-compat-http.js';

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; });

test('dispatch POSTs to baseUrl/v1/chat/completions and returns text + usage', async () => {
  const calls: any[] = [];
  global.fetch = mock(async (url: any, init: any) => {
    calls.push({ url: url.toString(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'hi back' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }));
  }) as any;

  const adapter = new OpenAiCompatHttpAdapter({
    baseUrl: 'http://example/v1', apiKey: 'tk', model: 'm',
  });
  const out = await adapter.dispatch({
    prompt: 'hi', conversation: { id: 'c', project_id: null }, config: {},
    signal: new AbortController().signal,
  });
  expect(out.text).toBe('hi back');
  expect(out.meta?.tokens_in).toBe(4);
  expect(out.meta?.tokens_out).toBe(2);
  expect(calls[0].url).toBe('http://example/v1/chat/completions');
  expect(calls[0].body.messages[0]).toEqual({ role: 'user', content: 'hi' });
});

test('dispatch raises on non-2xx', async () => {
  global.fetch = mock(async () => new Response('boom', { status: 500 })) as any;
  const adapter = new OpenAiCompatHttpAdapter({ baseUrl: 'http://example/v1', apiKey: 'tk', model: 'm' });
  await expect(adapter.dispatch({
    prompt: 'p', conversation: { id: 'c', project_id: null }, config: {},
    signal: new AbortController().signal,
  })).rejects.toThrow(/HTTP 500/);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/adapters/openai-compat-http.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the adapter**

```ts
// packages/agentchat/src/adapters/openai-compat-http.ts
import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';

export interface OpenAiCompatHttpOptions {
  baseUrl: string;        // e.g. https://192.168.68.76:7843/v1
  apiKey: string;
  model: string;
  maxTokens?: number;
}

export class OpenAiCompatHttpAdapter implements Adapter {
  readonly kind = 'openai-compat-http';
  constructor(private readonly opts: OpenAiCompatHttpOptions) {}

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: this.opts.model,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: this.opts.maxTokens ?? 1024,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
    if (!res.ok) throw new Error(`openai-compat-http: HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      meta: {
        model: data.model ?? this.opts.model,
        tokens_in: data.usage?.prompt_tokens,
        tokens_out: data.usage?.completion_tokens,
        raw_response: data,
      },
    };
  }
}
```

- [ ] **Step 4: Implement an adapter registry**

```ts
// packages/agentchat/src/adapters/registry.ts
import type { Adapter } from '../sdk/adapter.js';
import { OpenAiCompatHttpAdapter, type OpenAiCompatHttpOptions } from './openai-compat-http.js';

export type AdapterFactory = (options: Record<string, unknown>) => Adapter;

const builtIns: Record<string, AdapterFactory> = {
  'openai-compat-http': (o) => {
    const opts = o as Partial<OpenAiCompatHttpOptions> & { api_key_env?: string };
    const apiKey = opts.apiKey ?? (opts.api_key_env ? process.env[opts.api_key_env] : undefined);
    if (!opts.baseUrl) throw new Error('openai-compat-http: baseUrl is required');
    if (!apiKey) throw new Error('openai-compat-http: apiKey or api_key_env is required');
    if (!opts.model) throw new Error('openai-compat-http: model is required');
    return new OpenAiCompatHttpAdapter({ baseUrl: opts.baseUrl, apiKey, model: opts.model, maxTokens: opts.maxTokens });
  },
};

export function buildAdapter(kind: string, options: Record<string, unknown>): Adapter {
  const factory = builtIns[kind];
  if (!factory) throw new Error(`unknown adapter kind: ${kind}`);
  return factory(options);
}

export function registerAdapter(kind: string, factory: AdapterFactory): void {
  builtIns[kind] = factory;
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/adapters/openai-compat-http.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/adapters/ packages/agentchat/test/adapters/
git commit -m "feat(agentchat): openai-compat-http adapter + adapter registry"
```

---

### Task 16: Dispatcher — orchestrate a single handoff turn

**Files:**
- Create: `packages/agentchat/src/dispatcher.ts`
- Test: `packages/agentchat/test/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agentchat/test/dispatcher.test.ts
import { expect, test } from 'bun:test';
import { dispatchHandoff } from '../src/dispatcher.js';
import type { Adapter } from '../src/sdk/adapter.js';

test('dispatchHandoff runs the adapter and returns the response text', async () => {
  const calls: any[] = [];
  const adapter: Adapter = {
    kind: 'fake',
    async dispatch(input) {
      calls.push(input);
      return { text: 'response from gemini' };
    },
  };
  const result = await dispatchHandoff({
    adapter,
    prompt: 'go',
    conversation: { id: 'c', project_id: null },
    signal: new AbortController().signal,
    config: {},
  });
  expect(result.text).toBe('response from gemini');
  expect(calls.length).toBe(1);
  expect(calls[0].prompt).toBe('go');
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/dispatcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/agentchat/src/dispatcher.ts
import type { Adapter, DispatchInput, DispatchOutput } from './sdk/adapter.js';

export async function dispatchHandoff(args: DispatchInput & { adapter: Adapter }): Promise<DispatchOutput> {
  const { adapter, ...input } = args;
  return adapter.dispatch(input);
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/dispatcher.ts packages/agentchat/test/dispatcher.test.ts
git commit -m "feat(agentchat): dispatcher — single-turn adapter call"
```

---

### Task 17: CLI loop + inline approval (Milestone 1 user-facing entry)

**Files:**
- Create: `packages/agentchat/src/cli/loop.ts`
- Create: `packages/agentchat/src/cli/inline-approval.ts`
- Create: `packages/agentchat/bin/agentchat.ts`
- Test: `packages/agentchat/test/cli/loop.test.ts`

- [ ] **Step 1: Write the failing e2e-style test (in-process)**

```ts
// packages/agentchat/test/cli/loop.test.ts
import { expect, test } from 'bun:test';
import { runChatTurn } from '../../src/cli/loop.js';
import type { AgentChatConfig } from '../../src/config/types.js';
import { registerAdapter } from '../../src/adapters/registry.js';

const cfg: AgentChatConfig = {
  agents: [
    { name: 'echo', adapter: 'mock-echo', options: {}, roles: ['planner', 'executor'] },
  ],
  default_roles: { planner: 'echo', executor: 'echo' },
};

test('runChatTurn dispatches the planner with the user prompt and returns text', async () => {
  registerAdapter('mock-echo', () => ({
    kind: 'mock-echo',
    async dispatch({ prompt }) { return { text: `echo: ${prompt}` }; },
  }));

  const result = await runChatTurn({
    config: cfg,
    initialAgent: 'echo',
    userMessage: 'hello world',
    conversation: { id: 'c-1', project_id: null },
  });

  expect(result.text).toBe('echo: hello world');
  expect(result.next_mention).toBeNull();
});

test('runChatTurn extracts the first @mention from the response', async () => {
  registerAdapter('mock-echo', () => ({
    kind: 'mock-echo',
    async dispatch() { return { text: "Plan ready. @executor please run it." }; },
  }));

  const result = await runChatTurn({
    config: cfg,
    initialAgent: 'echo',
    userMessage: 'go',
    conversation: { id: 'c-1', project_id: null },
  });
  expect(result.next_mention?.target).toBe('executor');
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/cli/loop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runChatTurn`**

```ts
// packages/agentchat/src/cli/loop.ts
import { buildAdapter } from '../adapters/registry.js';
import { dispatchHandoff } from '../dispatcher.js';
import { parseMentions, type Mention } from '../mention/parser.js';
import { resolveMention, type Resolution } from '../mention/resolver.js';
import type { AgentChatConfig } from '../config/types.js';

export interface ChatTurnInput {
  config: AgentChatConfig;
  initialAgent: string;
  userMessage: string;
  conversation: { id: string; project_id: string | null };
  /** optional: override prompt assembly. If absent, the userMessage is sent verbatim. */
  prompt?: string;
}

export interface ChatTurnResult {
  text: string;
  next_mention: { target: string; resolution: Resolution } | null;
  /** raw mentions found in the response, in order */
  mentions: Mention[];
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const cfg = input.config.agents.find((a) => a.name === input.initialAgent);
  if (!cfg) throw new Error(`agent not found in config: ${input.initialAgent}`);
  const adapter = buildAdapter(cfg.adapter, cfg.options);
  const out = await dispatchHandoff({
    adapter,
    prompt: input.prompt ?? input.userMessage,
    conversation: input.conversation,
    config: {},
    signal: new AbortController().signal,
  });
  const mentions = parseMentions(out.text);
  const next = mentions[0]
    ? { target: mentions[0].target, resolution: resolveMention(mentions[0].target, input.config) }
    : null;
  return { text: out.text, next_mention: next, mentions };
}
```

- [ ] **Step 4: Implement inline approval prompt (stub for v1; tested separately later)**

```ts
// packages/agentchat/src/cli/inline-approval.ts
export type ApprovalChoice =
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'redirect'; target: string }
  | { kind: 'skip' };

export function parseApprovalKey(line: string): ApprovalChoice | null {
  const trimmed = line.trim();
  if (trimmed === 'y' || trimmed === 'yes') return { kind: 'yes' };
  if (trimmed === 'n' || trimmed === 'no') return { kind: 'no' };
  if (trimmed === 's' || trimmed === 'skip') return { kind: 'skip' };
  const m = trimmed.match(/^r(?:edirect)?\s+([A-Za-z0-9_-]+)$/);
  if (m) return { kind: 'redirect', target: m[1]! };
  return null;
}
```

Add a small test at `packages/agentchat/test/cli/inline-approval.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { parseApprovalKey } from '../../src/cli/inline-approval.js';

test('y/yes/n/no/s/skip parse correctly', () => {
  expect(parseApprovalKey('y')).toEqual({ kind: 'yes' });
  expect(parseApprovalKey('yes')).toEqual({ kind: 'yes' });
  expect(parseApprovalKey('n')).toEqual({ kind: 'no' });
  expect(parseApprovalKey('s')).toEqual({ kind: 'skip' });
});
test('redirect parses target', () => {
  expect(parseApprovalKey('r codex')).toEqual({ kind: 'redirect', target: 'codex' });
  expect(parseApprovalKey('redirect codex')).toEqual({ kind: 'redirect', target: 'codex' });
});
test('garbage returns null', () => {
  expect(parseApprovalKey('xyz')).toBeNull();
});
```

- [ ] **Step 5: Implement the CLI bin (minimal — interactive loop, single-shot approval inline)**

```ts
// packages/agentchat/bin/agentchat.ts
#!/usr/bin/env bun
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { PenumbraClient } from '../src/penumbra-client.js';
import { runChatTurn } from '../src/cli/loop.js';
import { parseApprovalKey } from '../src/cli/inline-approval.js';

const cmd = process.argv[2];
const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
const storageRoot = process.env.PENUMBRA_STORAGE_ROOT ?? join(homedir(), '.penumbra');

if (cmd === 'help' || cmd === '--help' || cmd === undefined) {
  console.log('usage: agentchat <new|resume|queue|approve|reject> [args]');
  process.exit(0);
}

if (cmd === 'new') {
  const project = process.argv[3] ?? null;
  const config = loadConfig(configPath);
  const conv = { id: `conv-${Date.now()}`, project_id: project };
  const penumbra = new PenumbraClient({ storageRoot });

  process.stdout.write(`> `);
  for await (const line of console as any) {
    const userMessage = (line as string).trim();
    if (!userMessage) { process.stdout.write(`> `); continue; }
    if (userMessage === 'done') break;

    const planner = config.default_roles.planner;
    if (!planner) { console.error('no default planner configured'); process.exit(1); }

    const turn = await runChatTurn({
      config, initialAgent: planner, userMessage, conversation: conv,
    });
    console.log(`\n[${planner}]\n${turn.text}\n`);

    if (turn.next_mention) {
      const handoff = await penumbra.createHandoff({
        from: planner,
        to: turn.next_mention.resolution.kind === 'unknown' ? turn.next_mention.target : (turn.next_mention.resolution as any).agent_name,
        to_role: turn.next_mention.resolution.kind === 'role' ? (turn.next_mention.resolution as any).role : null,
        message: turn.text,
        conversation_id: conv.id,
        project_id: conv.project_id,
        triggered_by_event_id: 'inline-1', // simplified for v1; real bin chains real event ids
      });
      process.stdout.write(`[handoff ${handoff.handoff_id.slice(0, 8)}…] @${turn.next_mention.target}\napprove? [y/n/r <name>/s] › `);
      const reply = await readOneLine();
      const choice = parseApprovalKey(reply);
      if (choice?.kind === 'yes') {
        await penumbra.approve(handoff.handoff_id);
        console.log(`approved.`);
      } else if (choice?.kind === 'redirect') {
        await penumbra.approve(handoff.handoff_id, { redirect_to: choice.target });
        console.log(`redirected → ${choice.target}.`);
      } else if (choice?.kind === 'no') {
        await penumbra.approve(handoff.handoff_id, { reject: true });
        console.log(`rejected.`);
      }
    }
    process.stdout.write(`> `);
  }
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(1);

async function readOneLine(): Promise<string> {
  for await (const l of console as any) return (l as string).trim();
  return '';
}
```

- [ ] **Step 6: Run unit tests, expect pass**

Run: `cd packages/agentchat && bun test test/cli/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/cli/ packages/agentchat/bin/ packages/agentchat/test/cli/
git commit -m "feat(agentchat): CLI loop, inline approval, and agentchat bin"
```

---

### Task 18: In-process end-to-end test (the Milestone 1 acceptance test)

**Files:**
- Test: `packages/agentchat/test/e2e/handoff-roundtrip.test.ts`

- [ ] **Step 1: Write the e2e test**

```ts
// packages/agentchat/test/e2e/handoff-roundtrip.test.ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, HandoffWriter, HandoffReader } from '@penumbra/core';
import { handoffsCreateRoute, handoffsApproveRoute, handoffsListPendingRoute } from '@penumbra/daemon/routes/handoffs.js';
import { runChatTurn } from '../../src/cli/loop.js';
import { registerAdapter } from '../../src/adapters/registry.js';
import type { AgentChatConfig } from '../../src/config/types.js';

test('user → planner → @executor → approve → executor responds', async () => {
  // Spin up a tiny in-memory penumbra-shaped service
  const db = new Database(':memory:');
  applySchema(db);
  const writer = new HandoffWriter({ db });
  const reader = new HandoffReader({ db });
  const services = {
    db, handoffWriter: writer, handoffReader: reader,
    machineId: { get: () => 'test' }, uuid: () => crypto.randomUUID(),
    clock: () => new Date(), t0Writer: { write: () => {} },
    redactor: { redact: (s: any) => s }, log: { info: () => {}, warn: () => {} },
  } as any;

  // Register two fake adapters
  registerAdapter('plan-bot', () => ({
    kind: 'plan-bot',
    async dispatch() { return { text: "Plan: 1) do X. @executor please run." }; },
  }));
  registerAdapter('exec-bot', () => ({
    kind: 'exec-bot',
    async dispatch({ prompt }) { return { text: `done: ${prompt}` }; },
  }));

  const config: AgentChatConfig = {
    agents: [
      { name: 'planner', adapter: 'plan-bot', options: {}, roles: ['planner'] },
      { name: 'gemini',  adapter: 'exec-bot', options: {}, roles: ['executor'] },
    ],
    default_roles: { planner: 'planner', executor: 'gemini' },
  };

  // 1) Planner runs
  const planTurn = await runChatTurn({
    config, initialAgent: 'planner',
    userMessage: 'add rate limiting',
    conversation: { id: 'c-e2e', project_id: 'auth' },
  });
  expect(planTurn.next_mention?.target).toBe('executor');
  expect(planTurn.next_mention?.resolution.kind).toBe('role');

  // 2) Create the handoff via the route
  const created = await (await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'planner', to: 'gemini', to_role: 'executor',
      message: planTurn.text, conversation_id: 'c-e2e', project_id: 'auth',
      triggered_by_event_id: 'evt-trigger',
    }),
  }), services)).json();
  expect(created.status).toBe('pending');

  // 3) Approve it
  const approved = await (await handoffsApproveRoute(
    new Request(`http://x/handoffs/${created.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    created.handoff_id, services,
  )).json();
  expect(approved.status).toBe('approved');

  // 4) Verify pending list is empty
  const list = await (await handoffsListPendingRoute(new Request('http://x/handoffs/pending'), services)).json();
  expect(list.handoffs.length).toBe(0);

  // 5) Executor runs against the planner's message
  const execTurn = await runChatTurn({
    config, initialAgent: 'gemini',
    userMessage: planTurn.text,
    conversation: { id: 'c-e2e', project_id: 'auth' },
  });
  expect(execTurn.text).toContain('done:');
});
```

- [ ] **Step 2: Run, expect pass**

Run: `cd packages/agentchat && bun test test/e2e/handoff-roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full monorepo suite**

Run: `cd /Volumes/WorkSSD/repos/personal/penumbra && bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/agentchat/test/e2e/
git commit -m "test(agentchat): in-process e2e for full plan→@executor→approve→exec roundtrip"
```

**🎯 Milestone 1 complete: a real handoff works end-to-end against a mock LLM. Next milestone replaces the mock with `openai-compat-http` against llamactl, then adds CLI adapters.**

---

## Milestone 2 — The Other Three Adapters

After M2, the user's full real workflow (Claude/Gemini/Codex/local) works.

### Task 19: Shared CLI subprocess helper

**Files:**
- Create: `packages/agentchat/src/adapters/cli-spawn.ts`
- Test: `packages/agentchat/test/adapters/cli-spawn.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agentchat/test/adapters/cli-spawn.test.ts
import { expect, test } from 'bun:test';
import { spawnCliAdapter } from '../../src/adapters/cli-spawn.js';

test('spawnCliAdapter pipes prompt to stdin and returns stdout', async () => {
  const out = await spawnCliAdapter({
    command: 'cat',
    args: [],
    prompt: 'hello\nworld\n',
    signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hello\nworld');
});

test('spawnCliAdapter throws on non-zero exit', async () => {
  await expect(spawnCliAdapter({
    command: 'sh',
    args: ['-c', 'exit 7'],
    prompt: '',
    signal: new AbortController().signal,
  })).rejects.toThrow(/exit code 7/);
});

test('spawnCliAdapter aborts on signal', async () => {
  const ac = new AbortController();
  const p = spawnCliAdapter({
    command: 'sleep', args: ['5'], prompt: '', signal: ac.signal,
  });
  ac.abort();
  await expect(p).rejects.toThrow();
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/adapters/cli-spawn.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/agentchat/src/adapters/cli-spawn.ts
export interface SpawnOpts {
  command: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
}

export async function spawnCliAdapter(opts: SpawnOpts): Promise<{ text: string }> {
  const proc = Bun.spawn([opts.command, ...opts.args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
    cwd: opts.cwd,
    signal: opts.signal,
  });
  proc.stdin.write(opts.prompt);
  await proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${opts.command}: exit code ${code}${err ? ` — ${err}` : ''}`);
  }
  return { text };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/adapters/cli-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/cli-spawn.ts packages/agentchat/test/adapters/cli-spawn.test.ts
git commit -m "feat(agentchat): shared subprocess helper for CLI adapters"
```

---

### Task 20: `claude-cli`, `gemini-cli`, `codex-cli` adapters

**Files:**
- Create: `packages/agentchat/src/adapters/claude-cli.ts`
- Create: `packages/agentchat/src/adapters/gemini-cli.ts`
- Create: `packages/agentchat/src/adapters/codex-cli.ts`
- Modify: `packages/agentchat/src/adapters/registry.ts`
- Test: `packages/agentchat/test/adapters/cli-adapters.test.ts`

- [ ] **Step 1: Write a single test that exercises all three (parameterized)**

```ts
// packages/agentchat/test/adapters/cli-adapters.test.ts
import { expect, test } from 'bun:test';
import { ClaudeCliAdapter } from '../../src/adapters/claude-cli.js';
import { GeminiCliAdapter } from '../../src/adapters/gemini-cli.js';
import { CodexCliAdapter } from '../../src/adapters/codex-cli.js';
import { buildAdapter } from '../../src/adapters/registry.js';

// Substitute the underlying command with `cat` so the test only verifies
// that the prompt round-trips and the adapter's plumbing works. The real
// argv shapes are validated by manual smoke tests against the actual CLIs.

test('claude-cli adapter pipes prompt → command → text', async () => {
  const adapter = new ClaudeCliAdapter({ command: 'cat', args: [] });
  const out = await adapter.dispatch({
    prompt: 'hi from test', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hi from test');
});

test('gemini-cli adapter pipes prompt → command → text', async () => {
  const adapter = new GeminiCliAdapter({ command: 'cat', args: [] });
  const out = await adapter.dispatch({
    prompt: 'hi gemini', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hi gemini');
});

test('codex-cli adapter pipes prompt → command → text', async () => {
  const adapter = new CodexCliAdapter({ command: 'cat', args: [] });
  const out = await adapter.dispatch({
    prompt: 'hi codex', conversation: { id: 'c', project_id: null },
    config: {}, signal: new AbortController().signal,
  });
  expect(out.text.trim()).toBe('hi codex');
});

test('registry resolves all three CLI adapters', () => {
  expect(() => buildAdapter('claude-cli', { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('gemini-cli', { command: 'cat' })).not.toThrow();
  expect(() => buildAdapter('codex-cli',  { command: 'cat' })).not.toThrow();
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/adapters/cli-adapters.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the three adapters**

```ts
// packages/agentchat/src/adapters/claude-cli.ts
import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { spawnCliAdapter } from './cli-spawn.js';

export interface ClaudeCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
}

export class ClaudeCliAdapter implements Adapter {
  readonly kind = 'claude-cli';
  constructor(private readonly opts: ClaudeCliOptions) {}
  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const out = await spawnCliAdapter({
      command: this.opts.command,
      args: this.opts.args ?? ['code', '--no-tty'],
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
    });
    return { text: out.text };
  }
}
```

```ts
// packages/agentchat/src/adapters/gemini-cli.ts
import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { spawnCliAdapter } from './cli-spawn.js';

export interface GeminiCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
}

export class GeminiCliAdapter implements Adapter {
  readonly kind = 'gemini-cli';
  constructor(private readonly opts: GeminiCliOptions) {}
  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const out = await spawnCliAdapter({
      command: this.opts.command,
      args: this.opts.args ?? [],
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
    });
    return { text: out.text };
  }
}
```

```ts
// packages/agentchat/src/adapters/codex-cli.ts
import type { Adapter, DispatchInput, DispatchOutput } from '../sdk/adapter.js';
import { spawnCliAdapter } from './cli-spawn.js';

export interface CodexCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
}

export class CodexCliAdapter implements Adapter {
  readonly kind = 'codex-cli';
  constructor(private readonly opts: CodexCliOptions) {}
  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const out = await spawnCliAdapter({
      command: this.opts.command,
      args: this.opts.args ?? [],
      prompt: input.prompt,
      signal: input.signal,
      cwd: this.opts.cwd,
    });
    return { text: out.text };
  }
}
```

- [ ] **Step 4: Register the three in the registry**

Edit `packages/agentchat/src/adapters/registry.ts`, extend `builtIns`:

```ts
import { ClaudeCliAdapter } from './claude-cli.js';
import { GeminiCliAdapter } from './gemini-cli.js';
import { CodexCliAdapter } from './codex-cli.js';

// inside builtIns:
'claude-cli': (o) => {
  const opts = o as { command?: string; args?: string[]; cwd?: string };
  if (!opts.command) throw new Error('claude-cli: command is required');
  return new ClaudeCliAdapter({ command: opts.command, args: opts.args, cwd: opts.cwd });
},
'gemini-cli': (o) => {
  const opts = o as { command?: string; args?: string[]; cwd?: string };
  if (!opts.command) throw new Error('gemini-cli: command is required');
  return new GeminiCliAdapter({ command: opts.command, args: opts.args, cwd: opts.cwd });
},
'codex-cli': (o) => {
  const opts = o as { command?: string; args?: string[]; cwd?: string };
  if (!opts.command) throw new Error('codex-cli: command is required');
  return new CodexCliAdapter({ command: opts.command, args: opts.args, cwd: opts.cwd });
},
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/adapters/cli-adapters.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/adapters/ packages/agentchat/test/adapters/cli-adapters.test.ts
git commit -m "feat(agentchat): claude-cli, gemini-cli, codex-cli adapters via shared spawn helper"
```

---

## Milestone 3 — Async approval surfaces (queue/approve CLI + MCP tools)

### Task 21: `agentchat queue` and `agentchat approve` / `reject` commands

**Files:**
- Modify: `packages/agentchat/bin/agentchat.ts`
- Create: `packages/agentchat/src/cli/queue.ts`
- Create: `packages/agentchat/src/cli/approve.ts`
- Test: `packages/agentchat/test/cli/queue-approve.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/agentchat/test/cli/queue-approve.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQueue } from '../../src/cli/queue.js';
import { runApprove } from '../../src/cli/approve.js';

test('runQueue lists pending handoffs by hitting penumbra', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      handoffs: [{
        handoff_id: 'h-1', ts: 't', from_agent: 'a', to_agent: 'b',
        message: 'go', status: 'pending', conversation_id: 'c', project_id: null,
        to_role: null, resolved_by: null, resolved_at: null, redirected_to: null,
        triggered_by_event_id: null,
      }],
    }),
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const rows = await runQueue({ storageRoot: root });
  expect(rows.length).toBe(1);
  expect(rows[0]!.handoff_id).toBe('h-1');
  server.stop(true);
});

test('runApprove POSTs approve with optional redirect', async () => {
  let received: { url: string; body: any } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      received = { url: new URL(req.url).pathname, body: await req.json() };
      return Response.json({ handoff_id: 'h-1', status: 'approved' });
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'aq-'));
  writeFileSync(join(root, 'port'), `${server.port}\n`);
  writeFileSync(join(root, 'token'), 'tk\n');

  const result = await runApprove({ storageRoot: root, handoffId: 'h-1' });
  expect(result.status).toBe('approved');
  expect(received!.url).toBe('/handoffs/h-1/approve');

  await runApprove({ storageRoot: root, handoffId: 'h-1', redirectTo: 'codex' });
  expect(received!.body).toEqual({ redirect_to: 'codex' });
  server.stop(true);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/agentchat && bun test test/cli/queue-approve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/agentchat/src/cli/queue.ts
import { PenumbraClient } from '../penumbra-client.js';
import type { HandoffRow } from '@penumbra/core';

export async function runQueue(opts: { storageRoot: string; conversationId?: string }): Promise<HandoffRow[]> {
  const client = new PenumbraClient({ storageRoot: opts.storageRoot });
  const r = await client.listPending({ conversation_id: opts.conversationId });
  return r.handoffs as HandoffRow[];
}
```

```ts
// packages/agentchat/src/cli/approve.ts
import { PenumbraClient } from '../penumbra-client.js';

export interface RunApproveOpts {
  storageRoot: string;
  handoffId: string;
  redirectTo?: string;
  reject?: boolean;
  reason?: string;
}

export async function runApprove(opts: RunApproveOpts): Promise<{ handoff_id: string; status: string }> {
  const client = new PenumbraClient({ storageRoot: opts.storageRoot });
  return client.approve(opts.handoffId, {
    redirect_to: opts.redirectTo,
    reject: opts.reject,
    reason: opts.reason,
  });
}
```

- [ ] **Step 4: Wire commands into the bin**

Append to `packages/agentchat/bin/agentchat.ts` before the final unknown-command branch:

```ts
if (cmd === 'queue') {
  const { runQueue } = await import('../src/cli/queue.js');
  const rows = await runQueue({ storageRoot });
  for (const r of rows) {
    console.log(`${r.handoff_id.slice(0, 8)}\t${r.ts}\t${r.from_agent}\t${r.to_agent}\t${r.status}\t${r.message.slice(0, 60)}`);
  }
  process.exit(0);
}

if (cmd === 'approve' || cmd === 'reject') {
  const id = process.argv[3];
  if (!id) { console.error(`usage: agentchat ${cmd} <handoff_id> [--redirect <name>] [--reason <text>]`); process.exit(1); }
  const redirectIdx = process.argv.indexOf('--redirect');
  const redirectTo = redirectIdx >= 0 ? (process.argv[redirectIdx + 1] ?? undefined) : undefined;
  const reasonIdx = process.argv.indexOf('--reason');
  const reason = reasonIdx >= 0 ? (process.argv[reasonIdx + 1] ?? undefined) : undefined;
  const { runApprove } = await import('../src/cli/approve.js');
  const r = await runApprove({
    storageRoot, handoffId: id,
    redirectTo, reason,
    reject: cmd === 'reject',
  });
  console.log(`${r.handoff_id} ${r.status}.`);
  process.exit(0);
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd packages/agentchat && bun test test/cli/queue-approve.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/cli/ packages/agentchat/bin/ packages/agentchat/test/cli/
git commit -m "feat(agentchat): async queue / approve / reject commands via penumbra HTTP"
```

---

### Task 22: MCP tools — `handoff.list_pending` and `handoff.approve`

**Files:**
- Create: `packages/mcp/src/tools/handoff-list.ts`
- Create: `packages/mcp/src/tools/handoff-approve.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Test: `packages/mcp/test/tools/handoff-list.test.ts`
- Test: `packages/mcp/test/tools/handoff-approve.test.ts`

- [ ] **Step 1: Add daemon-client methods**

Edit `packages/mcp/src/daemon-client.ts`. After `endSession`, add:

```ts
async listPendingHandoffs(opts: { conversation_id?: string } = {}): Promise<{ handoffs: any[] }> {
  const qs = opts.conversation_id ? `?conversation_id=${encodeURIComponent(opts.conversation_id)}` : '';
  return this.get(`/handoffs/pending${qs}`);
}

async approveHandoff(handoff_id: string, body: { redirect_to?: string; reject?: boolean; reason?: string } = {}): Promise<{ handoff_id: string; status: string }> {
  return this.post(`/handoffs/${handoff_id}/approve`, body);
}

private async get<T>(path: string): Promise<T> {
  const { baseUrl, token } = this.resolve();
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`daemon ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
```

(`this.resolve()` already exists from the earlier MCP fix.)

- [ ] **Step 2: Write the failing tests**

```ts
// packages/mcp/test/tools/handoff-list.test.ts
import { expect, test } from 'bun:test';
import { listHandoffsHandler } from '../../src/tools/handoff-list.js';

test('listHandoffsHandler returns pending list as content', async () => {
  const fakeClient = {
    listPendingHandoffs: async () => ({ handoffs: [{ handoff_id: 'h-1', from_agent: 'a', to_agent: 'b', message: 'go', ts: 't', status: 'pending' }] }),
  };
  const handler = listHandoffsHandler(fakeClient as any);
  const result = await handler({});
  expect(result.content[0]!.type).toBe('text');
  expect(JSON.parse(result.content[0]!.text)).toEqual([{ handoff_id: 'h-1', from_agent: 'a', to_agent: 'b', message: 'go', ts: 't', status: 'pending' }]);
});
```

```ts
// packages/mcp/test/tools/handoff-approve.test.ts
import { expect, test } from 'bun:test';
import { approveHandoffHandler } from '../../src/tools/handoff-approve.js';

test('approveHandoffHandler approves and returns status', async () => {
  let received: any = null;
  const fakeClient = {
    approveHandoff: async (id: string, body: any) => { received = { id, body }; return { handoff_id: id, status: 'approved' }; },
  };
  const handler = approveHandoffHandler(fakeClient as any);
  const result = await handler({ handoff_id: 'h-1' });
  expect(received).toEqual({ id: 'h-1', body: {} });
  expect(JSON.parse(result.content[0]!.text)).toEqual({ handoff_id: 'h-1', status: 'approved' });
});

test('approveHandoffHandler forwards redirect_to', async () => {
  let received: any = null;
  const fakeClient = {
    approveHandoff: async (id: string, body: any) => { received = body; return { handoff_id: id, status: 'redirected' }; },
  };
  const handler = approveHandoffHandler(fakeClient as any);
  await handler({ handoff_id: 'h-1', redirect_to: 'codex' });
  expect(received).toEqual({ redirect_to: 'codex' });
});
```

- [ ] **Step 3: Run, expect fail**

Run: `cd packages/mcp && bun test test/tools/handoff-list.test.ts test/tools/handoff-approve.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the tools**

```ts
// packages/mcp/src/tools/handoff-list.ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ListHandoffsInputShape = {
  conversation_id: z.string().optional(),
};

export function listHandoffsHandler(daemon: DaemonClient) {
  return async (input: { conversation_id?: string }) => {
    const r = await daemon.listPendingHandoffs(input.conversation_id ? { conversation_id: input.conversation_id } : {});
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(r.handoffs) }],
    };
  };
}
```

```ts
// packages/mcp/src/tools/handoff-approve.ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ApproveHandoffInputShape = {
  handoff_id: z.string(),
  redirect_to: z.string().optional(),
  reject: z.boolean().optional(),
  reason: z.string().optional(),
};

export function approveHandoffHandler(daemon: DaemonClient) {
  return async (input: { handoff_id: string; redirect_to?: string; reject?: boolean; reason?: string }) => {
    const body: { redirect_to?: string; reject?: boolean; reason?: string } = {};
    if (input.redirect_to) body.redirect_to = input.redirect_to;
    if (input.reject) body.reject = input.reject;
    if (input.reason) body.reason = input.reason;
    const r = await daemon.approveHandoff(input.handoff_id, body);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(r) }],
    };
  };
}
```

- [ ] **Step 5: Register the tools in `server.ts`**

Edit `packages/mcp/src/server.ts`:

```ts
import { ListHandoffsInputShape, listHandoffsHandler } from './tools/handoff-list.js';
import { ApproveHandoffInputShape, approveHandoffHandler } from './tools/handoff-approve.js';

// inside buildServer, after session.end registration:
server.registerTool(
  'handoff.list_pending',
  { description: 'List pending agent handoffs awaiting approval.', inputSchema: ListHandoffsInputShape },
  listHandoffsHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
server.registerTool(
  'handoff.approve',
  { description: 'Approve, redirect, or reject a pending handoff.', inputSchema: ApproveHandoffInputShape },
  approveHandoffHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
```

- [ ] **Step 6: Run all MCP tests, expect pass**

Run: `cd packages/mcp && bun test`
Expected: all green, two new tests pass.

- [ ] **Step 7: Run the full monorepo suite**

Run: `cd /Volumes/WorkSSD/repos/personal/penumbra && bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/src/server.ts packages/mcp/src/daemon-client.ts packages/mcp/test/tools/
git commit -m "feat(mcp): handoff.list_pending and handoff.approve tools"
```

---

### Task 23: Documentation + runbook

**Files:**
- Create: `packages/agentchat/README.md`
- Modify: `README.md` (root, mention agentchat in the package list if there is one)

- [ ] **Step 1: Write the README**

```markdown
# @penumbra/agentchat

Cross-agent group-chat orchestrator. Lets Claude / Gemini / Codex / local
LLMs talk to each other via `@mention`s, with the human in the loop only
to approve handoffs.

## Quick start

1. Make sure penumbra is running:
   ```
   penumbra init && penumbra start
   ```
2. Write `~/.config/agentchat/agentchat.yaml`:
   ```yaml
   agents:
     - name: claude
       adapter: claude-cli
       options: { command: claude }
       roles: [planner, reviewer]
     - name: gemini
       adapter: gemini-cli
       options: { command: gemini }
       roles: [executor]
     - name: codex
       adapter: codex-cli
       options: { command: codex }
       roles: [reviewer]
     - name: local
       adapter: openai-compat-http
       options:
         baseUrl: https://192.168.68.76:7843/v1
         api_key_env: LLAMACTL_TOKEN_LOCAL
         model: gemma-4-E4B-it-GGUF/...
       roles: [reviewer]

   default_roles:
     planner: claude
     executor: gemini
     reviewer: codex
   ```
3. Run a conversation:
   ```
   agentchat new my-project
   > Add rate limiting to /api/login
   ```

## Commands

- `agentchat new [project]` — start a new conversation
- `agentchat queue` — list pending handoffs
- `agentchat approve <id> [--redirect <name>]` — approve or redirect
- `agentchat reject <id> [--reason <text>]` — reject

## Mention semantics

- `@<role>` (e.g. `@executor`) → resolves via `default_roles`
- `@<name>` (e.g. `@gemini`) → resolves to the literal agent
- Role wins over name when both could match

## Adapters

Built-in: `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`.
Add your own by importing `Adapter`, `registerAdapter` from
`@penumbra/agentchat/sdk`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/agentchat/README.md
git commit -m "docs(agentchat): README with quickstart and command reference"
```

---

## Verification: full plan completed

- [ ] **Step 1: Run the full monorepo test suite**

Run: `cd /Volumes/WorkSSD/repos/personal/penumbra && bun test`
Expected: all tests pass; new agentchat package registered.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Live smoke (manual, opt-in)**

```bash
# Start daemon
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live penumbra start &

# Configure agentchat
mkdir -p ~/.config/agentchat
cp packages/agentchat/agentchat.example.yaml ~/.config/agentchat/agentchat.yaml
# (edit to match your real CLIs / API keys)

# Run
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live agentchat new dogfood
```

Type a real prompt; observe planner respond; approve the handoff; observe executor respond.

- [ ] **Step 4: Final commit if any cleanup remains**

```bash
git status
# If any straggler files
git add <specific paths>
git commit -m "chore: tidy after agentchat v1"
```

---

## Self-review notes (this plan)

- **Spec coverage:** Every section of the spec maps to a task — schema additions (T1–T3), writers/readers (T4–T5), daemon routes (T6–T7), package skeleton (T8), Adapter SDK + four adapters (T9, T15, T19, T20), config + mention machinery (T10–T12), HTTP client (T13), transcript slice (T14), dispatcher (T16), CLI loop + inline approval (T17), e2e test (T18), async CLI surfaces (T21), MCP surfaces (T22), docs (T23).
- **Type consistency:** `HandoffRow` shape is used identically in writer, reader, route, MCP client, and CLI — single source in `packages/core/src/schemas/handoff.ts`.
- **Open questions intentionally deferred:** real argv shapes for `claude-cli` / `gemini-cli` / `codex-cli` are pinned by config (`options.command`/`options.args`); manual smoke against real CLIs is left to the runbook step. Token-budget tuning is a config knob with a sensible default. Conversation lifecycle is fixed: explicit `done` from user, OR an agent response with no `@mention` (which the loop detects and stops dispatching).
