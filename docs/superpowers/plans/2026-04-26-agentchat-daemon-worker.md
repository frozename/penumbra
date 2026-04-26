# agentchat daemon-driven dispatch worker — phase 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-26-agentchat-daemon-worker-design.md`

**Goal:** Move agentchat dispatch out of the interactive bin into a long-running worker process, exposing a headless `POST /chains/start` so MCP/cron/webhooks can drive multi-agent chains without a TTY. Phase 1 only — bin's in-process dispatch path is preserved.

**Architecture:** New `agentchat worker` process polls/SSE-subscribes the penumbra daemon, claims `approved` handoffs via a new HTTP claim endpoint, dispatches via the existing `runChatTurn`, and writes t0 events back through the daemon. Daemon adds 4 new endpoints + 2 schema columns + an in-memory event bus. Worker reuses the bin's adapter pipeline; the auto-loop is refactored into a single-hop `dispatchHandoff` primitive used by both bin and worker.

**Tech Stack:** Bun 1.3, TypeScript, bun:sqlite, zod (already in repo). Tests use `bun:test`. No new deps.

---

## Execution waves (for parallel sub-agent dispatch)

Each task has a `Depends:` line. Tasks within the same wave can run in parallel against the same branch (or each in its own branch if isolation is desired).

| Wave | Tasks | Description |
|---|---|---|
| **A** | T1, T2, T3 | Foundations: schema, status filter, event bus, dispatchHandoff refactor — fully independent |
| **B** | T4, T5, T6, T7, T8 | New daemon routes (claim, complete, SSE, chains/start) + PenumbraClient extensions — depend on A |
| **C** | T9, T10, T11 | Worker pieces (event-source, dispatcher, bin entrypoint) — depend on A+B |
| **D** | T12 | MCP `penumbra__chain_start` tool — depends on B |
| **E** | T13, T14, T15 | Integration tests + docs — depend on C+D |

**Coding standards** (every task):
- TDD: failing test → run red → minimal impl → run green → commit per logical step.
- One test per assertion concept; do not bundle.
- No AI / agent attribution in commit messages — neutral, conventional commits.
- Bun ONNX teardown panic at end of `bun test` is cosmetic; judge by pass/fail counts, not exit code.
- Run `bun test packages/<pkg>/test/<file>.test.ts` for per-file iteration; `bun test` (from repo root) for full suite.

---

## Task 1 — Schema columns + HandoffReader.listByStatus + GET status filter

**Wave:** A &nbsp; **Depends:** —

**Files:**
- Modify: `packages/core/src/db/schema.ts` (add 2 columns to `handoffs` table)
- Modify: `packages/core/src/schemas/handoff.ts` (extend `HandoffRow` zod schema)
- Modify: `packages/core/src/readers/handoff.ts` (add `listByStatus`)
- Modify: `packages/daemon/src/routes/handoffs.ts` (extend `handoffsListPendingRoute` to honor `?status=<csv>`)
- Modify: `packages/daemon/src/serve.ts` (add new route path `/handoffs?...` already covered by the existing list route — add a second wired path `/handoffs` for the same handler, keeping `/handoffs/pending` for back-compat)
- Test: `packages/core/test/schemas/handoff.test.ts`, `packages/core/test/readers/handoff.test.ts`, `packages/daemon/test/routes/handoffs.test.ts`

### Step 1.1 — Failing schema test for new columns

Add to `packages/core/test/schemas/handoff.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, loadSqliteVec } from '@penumbra/core';

test('migration adds chain_max_hops and chain_trust_mode columns to handoffs', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const cols = db.query<{ name: string }, []>(
    `SELECT name FROM pragma_table_info('handoffs')`
  ).all().map((r) => r.name);
  expect(cols).toContain('chain_max_hops');
  expect(cols).toContain('chain_trust_mode');
});

test('inserts with chain_max_hops + chain_trust_mode succeed; existing inserts still work', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status,
                          chain_max_hops, chain_trust_mode)
    VALUES ('h1', '2026-04-26T00:00:00Z', 'c1', 'user', 'planner', 'go', 'approved', 5, 'all')
  `);
  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h2', '2026-04-26T00:00:00Z', 'c1', 'a', 'b', 'msg', 'pending')
  `);
  const row = db.query<{ chain_max_hops: number | null; chain_trust_mode: string | null }, [string]>(
    `SELECT chain_max_hops, chain_trust_mode FROM handoffs WHERE handoff_id=?`
  ).get('h1');
  expect(row?.chain_max_hops).toBe(5);
  expect(row?.chain_trust_mode).toBe('all');
  const row2 = db.query<{ chain_max_hops: number | null; chain_trust_mode: string | null }, [string]>(
    `SELECT chain_max_hops, chain_trust_mode FROM handoffs WHERE handoff_id=?`
  ).get('h2');
  expect(row2?.chain_max_hops).toBeNull();
  expect(row2?.chain_trust_mode).toBeNull();
});
```

- [ ] **Step 1.1:** Add the failing tests above.

- [ ] **Step 1.2:** Run `bun test packages/core/test/schemas/handoff.test.ts`. Expected: both new tests fail because columns are missing.

### Step 1.3 — Add columns to schema

Edit `packages/core/src/db/schema.ts`. Inside the `applySchema` SQL block, find the `CREATE TABLE IF NOT EXISTS handoffs (...)` definition and add two columns:

```sql
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
  triggered_by_event_id   TEXT,
  chain_max_hops          INTEGER,
  chain_trust_mode        TEXT
);
```

- [ ] **Step 1.3:** Apply the schema change.

- [ ] **Step 1.4:** Run `bun test packages/core/test/schemas/handoff.test.ts`. Expected: both new tests PASS along with existing ones.

### Step 1.5 — Extend HandoffRow zod schema

Edit `packages/core/src/schemas/handoff.ts`:

```ts
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
  chain_max_hops: z.number().int().nullable(),
  chain_trust_mode: z.enum(['all', 'config']).nullable(),
});
```

- [ ] **Step 1.5:** Update the schema.

- [ ] **Step 1.6:** Run `bun test packages/core/test/schemas/handoff.test.ts`. Expected: still green.

### Step 1.7 — Failing test for `HandoffReader.listByStatus`

Add to `packages/core/test/readers/handoff.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HandoffReader, HandoffWriter, migrate, loadSqliteVec } from '@penumbra/core';

function setup() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const writer = new HandoffWriter({ db });
  const reader = new HandoffReader({ db });
  return { db, writer, reader };
}

test('listByStatus returns rows matching any of the given statuses, ordered by ts', () => {
  const { db, writer, reader } = setup();
  writer.create({ handoff_id: 'h1', ts: '2026-04-26T00:00:01Z', conversation_id: 'c1',
    from: 'a', to: 'b', message: 'm1', triggered_by_event_id: 'e1' });
  writer.create({ handoff_id: 'h2', ts: '2026-04-26T00:00:02Z', conversation_id: 'c1',
    from: 'a', to: 'b', message: 'm2', triggered_by_event_id: 'e2' });
  writer.create({ handoff_id: 'h3', ts: '2026-04-26T00:00:03Z', conversation_id: 'c2',
    from: 'a', to: 'b', message: 'm3', triggered_by_event_id: 'e3' });
  writer.approve('h2', { resolved_by: 'u', resolved_at: '2026-04-26T00:00:10Z' });

  const pending = reader.listByStatus({ statuses: ['pending'] });
  expect(pending.map((r) => r.handoff_id)).toEqual(['h1', 'h3']);

  const both = reader.listByStatus({ statuses: ['pending', 'approved'] });
  expect(both.map((r) => r.handoff_id)).toEqual(['h1', 'h2', 'h3']);
});

test('listByStatus filters by conversation_id when given', () => {
  const { writer, reader } = setup();
  writer.create({ handoff_id: 'h1', ts: '2026-04-26T00:00:01Z', conversation_id: 'cA',
    from: 'a', to: 'b', message: 'm', triggered_by_event_id: 'e' });
  writer.create({ handoff_id: 'h2', ts: '2026-04-26T00:00:02Z', conversation_id: 'cB',
    from: 'a', to: 'b', message: 'm', triggered_by_event_id: 'e' });

  const r = reader.listByStatus({ statuses: ['pending'], conversation_id: 'cA' });
  expect(r.map((x) => x.handoff_id)).toEqual(['h1']);
});

test('listByStatus rejects empty status list', () => {
  const { reader } = setup();
  expect(() => reader.listByStatus({ statuses: [] })).toThrow();
});
```

- [ ] **Step 1.7:** Add the failing tests.

- [ ] **Step 1.8:** Run `bun test packages/core/test/readers/handoff.test.ts`. Expected: 3 new tests fail with `listByStatus is not a function`.

### Step 1.9 — Implement `listByStatus`

Edit `packages/core/src/readers/handoff.ts`:

```ts
import type { Database } from 'bun:sqlite';
import type { HandoffRow, HandoffStatus } from '../schemas/handoff.js';

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

  listByStatus(opts: { statuses: HandoffStatus[]; conversation_id?: string }): HandoffRow[] {
    if (opts.statuses.length === 0) {
      throw new Error('listByStatus: statuses must not be empty');
    }
    const placeholders = opts.statuses.map(() => '?').join(',');
    if (opts.conversation_id) {
      const sql = `SELECT * FROM handoffs WHERE status IN (${placeholders}) AND conversation_id=? ORDER BY ts ASC`;
      return this.db.query<HandoffRow, string[]>(sql).all(...opts.statuses, opts.conversation_id);
    }
    const sql = `SELECT * FROM handoffs WHERE status IN (${placeholders}) ORDER BY ts ASC`;
    return this.db.query<HandoffRow, string[]>(sql).all(...opts.statuses);
  }

  get(handoff_id: string): HandoffRow | null {
    const row = this.db
      .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
      .get(handoff_id);
    return row ?? null;
  }
}
```

- [ ] **Step 1.9:** Add `listByStatus` to `HandoffReader`.

- [ ] **Step 1.10:** Run `bun test packages/core/test/readers/handoff.test.ts`. Expected: green.

### Step 1.11 — Failing test for `?status=` query param

Add to `packages/daemon/test/routes/handoffs.test.ts` (note: existing helper `makeServices` works; do not modify it):

```ts
test('GET /handoffs?status=approved returns only approved rows', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // seed two handoffs
  await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm1', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services);
  const created2 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm2', conversation_id: 'c1', triggered_by_event_id: 'e2' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    created2.handoff_id, services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=approved`), services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].handoff_id).toBe(created2.handoff_id);
  expect(body.handoffs[0].status).toBe('approved');
});

test('GET /handoffs?status=pending,approved returns both', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const c1 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm1', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  const c2 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm2', conversation_id: 'c1', triggered_by_event_id: 'e2' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${c2.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    c2.handoff_id, services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=pending,approved`), services,
  );
  const body = await res.json();
  const ids = body.handoffs.map((h: any) => h.handoff_id).sort();
  expect(ids).toEqual([c1.handoff_id, c2.handoff_id].sort());
});

test('GET /handoffs without status param defaults to pending (back-compat)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs`), services,
  );
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].status).toBe('pending');
});

test('GET /handoffs?status=garbage returns 400', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=garbage`), services,
  );
  expect(res.status).toBe(400);
});
```

- [ ] **Step 1.11:** Add the four failing tests.

- [ ] **Step 1.12:** Run `bun test packages/daemon/test/routes/handoffs.test.ts`. Expected: 4 new tests fail.

### Step 1.13 — Extend the list route

Edit `packages/daemon/src/routes/handoffs.ts`. Replace `handoffsListPendingRoute`:

```ts
import { HandoffStatusSchema } from '@penumbra/core';
// ... existing imports ...

const VALID_STATUSES = new Set(HandoffStatusSchema.options);

export async function handoffsListPendingRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conv = url.searchParams.get('conversation_id') ?? undefined;
  const statusParam = url.searchParams.get('status');

  if (statusParam !== null) {
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 0) return json({ error: { code: 'validation_error', message: 'status is empty' } }, 400);
    for (const s of statuses) {
      if (!VALID_STATUSES.has(s as any)) {
        return json({ error: { code: 'validation_error', message: `unknown status: ${s}` } }, 400);
      }
    }
    const handoffs = services.handoffReader.listByStatus({
      statuses: statuses as any,
      conversation_id: conv,
    });
    return json({ handoffs });
  }

  // No status param: back-compat — pending only
  const handoffs = services.handoffReader.listPending(conv ? { conversation_id: conv } : undefined);
  return json({ handoffs });
}
```

- [ ] **Step 1.13:** Apply the route change.

- [ ] **Step 1.14:** Wire `/handoffs` (no `/pending`) as an alias in `packages/daemon/src/serve.ts`. Inside the `fetch` handler, add this line right above the existing `/handoffs/pending` block:

```ts
if (req.method === 'GET' && url.pathname === '/handoffs') {
  return handoffsListPendingRoute(req, opts.services);
}
if (req.method === 'GET' && url.pathname === '/handoffs/pending') {
  return handoffsListPendingRoute(req, opts.services);
}
```

- [ ] **Step 1.15:** Run `bun test packages/daemon/test/routes/handoffs.test.ts`. Expected: green (existing tests still pass; 4 new pass).

### Step 1.16 — Commit

```bash
git add packages/core/src/db/schema.ts packages/core/src/schemas/handoff.ts \
  packages/core/src/readers/handoff.ts packages/core/test/schemas/handoff.test.ts \
  packages/core/test/readers/handoff.test.ts \
  packages/daemon/src/routes/handoffs.ts packages/daemon/src/serve.ts \
  packages/daemon/test/routes/handoffs.test.ts
git commit -m "feat(core,daemon): chain_max_hops/trust columns, listByStatus, GET /handoffs status filter"
```

- [ ] **Step 1.16:** Commit.

---

## Task 2 — In-memory `handoffEvents` bus + Services wiring

**Wave:** A &nbsp; **Depends:** —

**Files:**
- Create: `packages/core/src/events/handoff-events.ts`
- Modify: `packages/core/src/index.ts` (export `HandoffEventBus`)
- Modify: `packages/core/src/services.ts` (add `handoffEvents` to `Services` and instantiate in `buildServices`)
- Modify: `packages/core/src/writers/handoff.ts` (call bus from `approve` if injected)
- Test: `packages/core/test/events/handoff-events.test.ts`

### Step 2.1 — Failing bus test

Create `packages/core/test/events/handoff-events.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { HandoffEventBus } from '@penumbra/core';

test('subscribers receive emitted events in order', () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  bus.subscribe((row) => seen.push(row.handoff_id));
  bus.emit({ handoff_id: 'a' } as any);
  bus.emit({ handoff_id: 'b' } as any);
  bus.emit({ handoff_id: 'c' } as any);
  expect(seen).toEqual(['a', 'b', 'c']);
});

test('multiple subscribers each receive every event', () => {
  const bus = new HandoffEventBus();
  const a: string[] = []; const b: string[] = [];
  bus.subscribe((r) => a.push(r.handoff_id));
  bus.subscribe((r) => b.push(r.handoff_id));
  bus.emit({ handoff_id: 'x' } as any);
  expect(a).toEqual(['x']);
  expect(b).toEqual(['x']);
});

test('unsubscribe stops further delivery', () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  const off = bus.subscribe((r) => seen.push(r.handoff_id));
  bus.emit({ handoff_id: 'a' } as any);
  off();
  bus.emit({ handoff_id: 'b' } as any);
  expect(seen).toEqual(['a']);
});

test('a subscriber that throws does not block other subscribers', () => {
  const bus = new HandoffEventBus();
  const seen: string[] = [];
  bus.subscribe(() => { throw new Error('boom'); });
  bus.subscribe((r) => seen.push(r.handoff_id));
  bus.emit({ handoff_id: 'x' } as any);
  expect(seen).toEqual(['x']);
});
```

- [ ] **Step 2.1:** Add the failing tests.

- [ ] **Step 2.2:** Run `bun test packages/core/test/events/handoff-events.test.ts`. Expected: import error (`HandoffEventBus is not exported`).

### Step 2.3 — Implement the bus

Create `packages/core/src/events/handoff-events.ts`:

```ts
import type { HandoffRow } from '../schemas/handoff.js';

export type HandoffEventListener = (row: HandoffRow) => void;

export class HandoffEventBus {
  private listeners = new Set<HandoffEventListener>();

  subscribe(fn: HandoffEventListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  emit(row: HandoffRow): void {
    for (const fn of this.listeners) {
      try { fn(row); } catch { /* one bad subscriber must not block the others */ }
    }
  }
}
```

- [ ] **Step 2.3:** Create the file.

- [ ] **Step 2.4:** Edit `packages/core/src/index.ts` — add at the bottom:

```ts
export { HandoffEventBus, type HandoffEventListener } from './events/handoff-events.js';
```

- [ ] **Step 2.5:** Run `bun test packages/core/test/events/handoff-events.test.ts`. Expected: green.

### Step 2.6 — Wire into Services

Edit `packages/core/src/services.ts`:

```ts
// add to imports
import { HandoffEventBus } from './events/handoff-events.js';

// add to Services interface (between handoffReader and supervisor):
handoffEvents: HandoffEventBus;

// add to buildServices return object:
handoffEvents: new HandoffEventBus(),
```

- [ ] **Step 2.6:** Apply the Services changes.

### Step 2.7 — Failing test: writer emits on approve

Add to `packages/core/test/writers/handoff.test.ts`:

```ts
import { HandoffEventBus } from '@penumbra/core';

test('HandoffWriter.approve emits a handoff-events event when bus is provided', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  writer.create({ handoff_id: 'h1', ts: '2026-04-26T00:00:00Z', conversation_id: 'c1',
    from: 'a', to: 'b', message: 'm', triggered_by_event_id: 'e' });

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  writer.approve('h1', { resolved_by: 'u', resolved_at: '2026-04-26T00:00:01Z' });
  expect(seen).toContain('h1:approved');
});

test('HandoffWriter.approve emits redirected status when redirect_to set', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  writer.create({ handoff_id: 'h1', ts: '2026-04-26T00:00:00Z', conversation_id: 'c1',
    from: 'a', to: 'b', message: 'm', triggered_by_event_id: 'e' });

  const seen: string[] = [];
  bus.subscribe((row) => seen.push(`${row.handoff_id}:${row.status}`));

  writer.approve('h1', { resolved_by: 'u', resolved_at: '2026-04-26T00:00:01Z', redirect_to: 'gemini' });
  expect(seen).toContain('h1:redirected');
});
```

(Reuse the file's existing imports — add `HandoffEventBus` to the existing `import { ... } from '@penumbra/core'` line.)

- [ ] **Step 2.7:** Add the two tests.

- [ ] **Step 2.8:** Run `bun test packages/core/test/writers/handoff.test.ts`. Expected: 2 new tests fail (writer doesn't accept `events` opt yet).

### Step 2.9 — Wire bus into HandoffWriter

Edit `packages/core/src/writers/handoff.ts`:

```ts
import type { Database } from 'bun:sqlite';
import type { CreateHandoffRequest, HandoffRow } from '../schemas/handoff.js';
import type { HandoffEventBus } from '../events/handoff-events.js';

export interface HandoffWriterOpts { db: Database; events?: HandoffEventBus }

// ... CreateHandoffParams unchanged ...

export class HandoffWriter {
  private readonly db: Database;
  private readonly events: HandoffEventBus | undefined;
  constructor(opts: HandoffWriterOpts) {
    this.db = opts.db;
    this.events = opts.events;
  }

  // create() unchanged

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
    if (this.events) {
      const row = this.db
        .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
        .get(handoff_id);
      if (row) this.events.emit(row);
    }
    return { status, redirected_to };
  }

  // reject(), claimDispatch(), markCompleted() unchanged
}
```

Now also update `packages/core/src/services.ts` so `buildServices` injects the bus:

```ts
const handoffEvents = new HandoffEventBus();
// ... in the return object, replace the handoffWriter line:
handoffWriter: new HandoffWriter({ db: opts.db, events: handoffEvents }),
handoffReader: new HandoffReader({ db: opts.db }),
handoffEvents,
```

- [ ] **Step 2.9:** Apply both edits.

- [ ] **Step 2.10:** Run `bun test packages/core/test/writers/handoff.test.ts`. Expected: green.

### Step 2.11 — Commit

```bash
git add packages/core/src/events/handoff-events.ts \
        packages/core/src/index.ts \
        packages/core/src/services.ts \
        packages/core/src/writers/handoff.ts \
        packages/core/test/events/handoff-events.test.ts \
        packages/core/test/writers/handoff.test.ts
git commit -m "feat(core): in-memory HandoffEventBus emitted from writer.approve"
```

- [ ] **Step 2.11:** Commit.

---

## Task 3 — Refactor `runAutoChain` into `dispatchHandoff` primitive

**Wave:** A &nbsp; **Depends:** —

**Goal:** Extract a single-hop function `dispatchHandoff(handoff, opts)` that takes one approved handoff and runs exactly one chat turn, returning the next handoff (if any) and a terminal reason. `runAutoChain` is rewritten as a thin loop over `dispatchHandoff`. Existing public API of `runAutoChain` stays identical so the bin is untouched.

**Files:**
- Create: `packages/agentchat/src/cli/dispatch-handoff.ts`
- Create: `packages/agentchat/test/cli/dispatch-handoff.test.ts`
- Modify: `packages/agentchat/src/cli/auto-loop.ts` (rewrite around `dispatchHandoff`)
- Existing tests (`auto-loop.test.ts`) stay green.

### Step 3.1 — Failing tests for `dispatchHandoff`

Create `packages/agentchat/test/cli/dispatch-handoff.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { dispatchHandoff } from '../../src/cli/dispatch-handoff.js';
import type { ChatTurnResult } from '../../src/cli/loop.js';

const mockConv = { id: 'c1', project_id: null };
const cfg = {
  agents: [
    { name: 'planner', adapter: 'a', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
    { name: 'executor', adapter: 'a', options: {}, roles: ['executor'], auto_approve_to: [] },
  ],
  default_roles: {},
};
const baseHandoff = {
  handoff_id: 'h0', ts: 't', project_id: null, conversation_id: 'c1',
  from_agent: 'user', to_agent: 'planner', to_role: null, message: 'hi',
  status: 'approved', resolved_by: null, resolved_at: null, redirected_to: null,
  triggered_by_event_id: null, chain_max_hops: null, chain_trust_mode: null,
};

test('chain-start handoff (from=user) sends raw message, no transcript wrap', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'done', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
  } as ChatTurnResult);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  expect(res.terminatedReason).toBe('no_mention');
  expect(res.next).toBeNull();
  const call = runChatTurn.mock.calls[0]![0];
  expect(call.initialAgent).toBe('planner');
  expect(call.prompt).toBeUndefined(); // raw message via userMessage path
  expect(call.userMessage).toBe('hi');
});

test('continuation handoff wraps transcript via buildNextPrompt', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ok', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
  } as ChatTurnResult);

  const continuation = { ...baseHandoff, handoff_id: 'h1', from_agent: 'planner', to_agent: 'executor', message: 'do the thing' };
  await dispatchHandoff({
    handoff: continuation,
    config: cfg,
    conversation: mockConv,
    transcript: [{ agent: 'user', text: 'hi' }, { agent: 'planner', text: 'do the thing' }],
    transcriptBudget: 1000,
    hopsSoFar: 1,
    maxHops: 5,
    trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });
  const call = runChatTurn.mock.calls[0]![0];
  expect(call.initialAgent).toBe('executor');
  expect(call.prompt).toContain('From @planner: do the thing');
  expect(call.prompt).toContain('[user]: hi');
});

test('mention triggers handoff create + approve when trustMode=all', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ping @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-next', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(createHandoff.mock.calls[0]![0]).toMatchObject({ from: 'planner', to: 'executor' });
  expect(approve).toHaveBeenCalledWith('h-next', { resolved_by: 'auto' });
  expect(res.terminatedReason).toBeUndefined();
  expect(res.next?.handoff_id).toBe('h-next');
});

test('mention with trustMode=config + edge in auto_approve_to → approves', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ping @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h2', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'config',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(approve).toHaveBeenCalled();
  expect(res.terminatedReason).toBeUndefined();
});

test('mention with trustMode=config + edge NOT in auto_approve_to → leaves pending, returns untrusted', async () => {
  const cfgNoTrust = {
    agents: [
      { name: 'planner', adapter: 'a', options: {}, roles: ['planner'], auto_approve_to: [] },
      { name: 'executor', adapter: 'a', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: {},
  };
  const runChatTurn = mock().mockResolvedValue({
    text: 'ping @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-untrusted', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfgNoTrust, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'config',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe('untrusted');
  expect(res.next).toBeNull();
  expect(res.cappedHandoffId).toBe('h-untrusted');
});

test('hopsSoFar+1 >= maxHops → creates handoff but does not approve, returns max_hops', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'go @executor', prompt_event_id: 'p', response_event_id: 'r1',
    next_mention: { target: 'executor', resolution: { kind: 'name', agent_name: 'executor' } },
    mentions: [],
  } as ChatTurnResult);
  const createHandoff = mock().mockResolvedValue({ handoff_id: 'h-cap', status: 'pending' });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 4, maxHops: 5, trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve, runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe('max_hops');
  expect(res.cappedHandoffId).toBe('h-cap');
});

test('runChatTurn error → returns error, no next handoff', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: '', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
    error: { message: 'adapter blew up' },
  } as ChatTurnResult);
  const createHandoff = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff, config: cfg, conversation: mockConv,
    transcript: [], transcriptBudget: 1000,
    hopsSoFar: 0, maxHops: 5, trustMode: 'all',
    observe: async () => ({ event_id: 'e' }),
    createHandoff, approve: mock(), runChatTurn,
  });

  expect(res.terminatedReason).toBe('error');
  expect(res.next).toBeNull();
  expect(createHandoff).not.toHaveBeenCalled();
});

test('projectContext is threaded through to buildNextPrompt for continuation hops', async () => {
  const runChatTurn = mock().mockResolvedValue({
    text: 'ok', prompt_event_id: 'p', response_event_id: 'r',
    next_mention: null, mentions: [],
  } as ChatTurnResult);

  const continuation = { ...baseHandoff, handoff_id: 'h1', from_agent: 'planner', to_agent: 'executor', message: 'do' };
  await dispatchHandoff({
    handoff: continuation, config: cfg, conversation: mockConv,
    transcript: [{ agent: 'user', text: 'hi' }],
    transcriptBudget: 1000,
    hopsSoFar: 1, maxHops: 5, trustMode: 'all',
    projectContext: 'PROJECT-CTX-MARKER',
    observe: async () => ({ event_id: 'e' }),
    createHandoff: mock(), approve: mock(), runChatTurn,
  });
  expect(runChatTurn.mock.calls[0]![0].prompt).toContain('PROJECT-CTX-MARKER');
});
```

- [ ] **Step 3.1:** Add the test file.

- [ ] **Step 3.2:** Run `bun test packages/agentchat/test/cli/dispatch-handoff.test.ts`. Expected: import error.

### Step 3.3 — Implement `dispatchHandoff`

Create `packages/agentchat/src/cli/dispatch-handoff.ts`:

```ts
import type { AgentChatConfig } from '../config/types.js';
import type { ChatTurnInput, ChatTurnResult } from './loop.js';
import { runChatTurn as realRunChatTurn } from './loop.js';
import { buildNextPrompt } from './transcript.js';
import { isAutoApproved } from './trust.js';
import type { HandoffRow } from '@penumbra/core';

export interface DispatchHandoffOpts {
  handoff: HandoffRow;
  config: AgentChatConfig;
  conversation: { id: string; project_id: string | null };
  transcript: { agent: string; text: string }[];
  transcriptBudget: number;
  hopsSoFar: number;
  maxHops: number;
  trustMode: 'all' | 'config';
  projectContext?: string;
  observe: (event: any) => Promise<{ event_id: string }>;
  createHandoff: (body: any) => Promise<{ handoff_id: string; status: string }>;
  approve: (id: string, body: any) => Promise<{ handoff_id: string; status: string }>;
  runChatTurn?: (input: ChatTurnInput) => Promise<ChatTurnResult>;
  onChunk?: (delta: string) => void;
}

export interface DispatchHandoffResult {
  /** The newly-created next handoff (created+approved) when the chain continues. Null on terminal cases. */
  next: { handoff_id: string; from: string; to: string; message: string; response_event_id: string } | null;
  /** Set when this hop was the last (no_mention | error | untrusted | max_hops). Absent if next is non-null. */
  terminatedReason?: 'no_mention' | 'error' | 'untrusted' | 'max_hops';
  /** The handoff id that was created but not approved (untrusted | max_hops). */
  cappedHandoffId?: string;
  /** Final accumulated reply text from this hop (for transcript building by the caller). */
  text: string;
  /** The dispatching agent for this hop (handoff.to_agent). */
  agent: string;
}

export async function dispatchHandoff(opts: DispatchHandoffOpts): Promise<DispatchHandoffResult> {
  const turnRunner = opts.runChatTurn ?? realRunChatTurn;
  const targetAgent = opts.handoff.to_agent;

  const isChainStart = opts.handoff.from_agent === 'user';
  const promptText = isChainStart
    ? undefined
    : buildNextPrompt(opts.transcript, opts.handoff.from_agent, opts.handoff.message, {
        maxTokens: opts.transcriptBudget,
        projectContext: opts.projectContext,
      });

  const turn = await turnRunner({
    config: opts.config,
    initialAgent: targetAgent,
    userMessage: opts.handoff.message,
    conversation: opts.conversation,
    prompt: promptText,
    observe: opts.observe,
    onChunk: opts.onChunk,
  });

  if (turn.error) {
    return { next: null, terminatedReason: 'error', text: turn.text, agent: targetAgent };
  }
  if (!turn.next_mention) {
    return { next: null, terminatedReason: 'no_mention', text: turn.text, agent: targetAgent };
  }

  const nextTo = turn.next_mention.resolution.kind === 'unknown'
    ? turn.next_mention.target
    : (turn.next_mention.resolution as any).agent_name;
  const nextRole = turn.next_mention.resolution.kind === 'role'
    ? (turn.next_mention.resolution as any).role
    : null;

  const created = await opts.createHandoff({
    from: targetAgent,
    to: nextTo,
    to_role: nextRole,
    message: turn.text,
    conversation_id: opts.conversation.id,
    project_id: opts.conversation.project_id,
    triggered_by_event_id: turn.response_event_id,
  });

  // hop cap is checked against hopsSoFar+1 (this hop completed; the next would be hopsSoFar+1)
  if (opts.hopsSoFar + 1 >= opts.maxHops) {
    return {
      next: null, terminatedReason: 'max_hops', cappedHandoffId: created.handoff_id,
      text: turn.text, agent: targetAgent,
    };
  }

  if (opts.trustMode === 'config' && !isAutoApproved(opts.config, targetAgent, nextTo)) {
    return {
      next: null, terminatedReason: 'untrusted', cappedHandoffId: created.handoff_id,
      text: turn.text, agent: targetAgent,
    };
  }

  await opts.approve(created.handoff_id, { resolved_by: 'auto' });

  return {
    next: {
      handoff_id: created.handoff_id, from: targetAgent, to: nextTo,
      message: turn.text, response_event_id: turn.response_event_id,
    },
    text: turn.text, agent: targetAgent,
  };
}
```

- [ ] **Step 3.3:** Create the file.

- [ ] **Step 3.4:** Run `bun test packages/agentchat/test/cli/dispatch-handoff.test.ts`. Expected: green.

### Step 3.5 — Rewrite `runAutoChain` around `dispatchHandoff`

Edit `packages/agentchat/src/cli/auto-loop.ts` — replace the entire body:

```ts
import type { AgentChatConfig } from '../config/types.js';
import { runChatTurn as realRunChatTurn, type ChatTurnInput, type ChatTurnResult } from './loop.js';
import { dispatchHandoff } from './dispatch-handoff.js';

export interface AutoChainOpts {
  config: AgentChatConfig;
  initialAgent: string;
  userMessage: string;
  conversation: { id: string; project_id: string | null };
  maxHops: number;
  transcriptBudget: number;
  observe: (event: any) => Promise<{ event_id: string }>;
  createHandoff: (body: any) => Promise<{ handoff_id: string; status: string }>;
  approve: (id: string, body: any) => Promise<{ handoff_id: string; status: string }>;
  runChatTurn?: (input: ChatTurnInput) => Promise<ChatTurnResult>;
  trustMode?: 'all' | 'config';
  projectContext?: string;
  onChunk?: (delta: string) => void;
}

export async function runAutoChain(opts: AutoChainOpts): Promise<{
  hops: number;
  terminatedReason: 'no_mention' | 'max_hops' | 'untrusted' | 'error';
  cappedHandoffId?: string;
}> {
  const trustMode = opts.trustMode ?? 'all';
  const transcript: { agent: string; text: string }[] = [{ agent: 'user', text: opts.userMessage }];

  // Synthesize an initial chain-start handoff for the loop. We never persist this row;
  // dispatchHandoff treats from_agent === 'user' specially (no transcript wrap).
  let currentHandoff: any = {
    handoff_id: '__synthetic_chain_start__', ts: '', project_id: null,
    conversation_id: opts.conversation.id,
    from_agent: 'user', to_agent: opts.initialAgent, to_role: null,
    message: opts.userMessage, status: 'approved',
    resolved_by: null, resolved_at: null, redirected_to: null,
    triggered_by_event_id: null, chain_max_hops: null, chain_trust_mode: null,
  };

  let hops = 0;
  while (true) {
    hops++;
    process.stdout.write(`\n[${currentHandoff.to_agent}]\n`);
    const res = await dispatchHandoff({
      handoff: currentHandoff,
      config: opts.config,
      conversation: opts.conversation,
      transcript,
      transcriptBudget: opts.transcriptBudget,
      hopsSoFar: hops - 1,
      maxHops: opts.maxHops,
      trustMode,
      projectContext: opts.projectContext,
      observe: opts.observe,
      createHandoff: opts.createHandoff,
      approve: opts.approve,
      runChatTurn: opts.runChatTurn ?? realRunChatTurn,
      onChunk: opts.onChunk,
    });
    process.stdout.write('\n\n');

    if (res.terminatedReason === 'error') {
      return { hops, terminatedReason: 'error' };
    }
    if (res.terminatedReason === 'no_mention') {
      return { hops, terminatedReason: 'no_mention' };
    }
    if (res.terminatedReason === 'max_hops') {
      return { hops, terminatedReason: 'max_hops', cappedHandoffId: res.cappedHandoffId! };
    }
    if (res.terminatedReason === 'untrusted') {
      console.log(`[untrusted edge ${currentHandoff.to_agent}→${res.next ? res.next.to : '?'}, handoff ${res.cappedHandoffId!.slice(0, 8)} queued]`);
      return { hops, terminatedReason: 'untrusted', cappedHandoffId: res.cappedHandoffId! };
    }

    // Continue: shape the next synthetic handoff.
    transcript.push({ agent: currentHandoff.to_agent, text: res.text });
    console.log(`[auto-approved → ${res.next!.to}]`);
    currentHandoff = {
      handoff_id: res.next!.handoff_id, ts: '', project_id: null,
      conversation_id: opts.conversation.id,
      from_agent: res.next!.from, to_agent: res.next!.to, to_role: null,
      message: res.next!.message, status: 'approved',
      resolved_by: 'auto', resolved_at: null, redirected_to: null,
      triggered_by_event_id: res.next!.response_event_id,
      chain_max_hops: null, chain_trust_mode: null,
    };
  }
}
```

- [ ] **Step 3.5:** Replace the file content.

- [ ] **Step 3.6:** Run `bun test packages/agentchat/test/cli/auto-loop.test.ts packages/agentchat/test/cli/dispatch-handoff.test.ts`. Expected: all green. The existing 5 auto-loop tests must still pass unchanged because `runAutoChain`'s public behavior is preserved.

- [ ] **Step 3.7:** Run full agentchat suite: `bun test packages/agentchat`. Expected: pass count is at least the prior count + 8 new dispatch-handoff tests. No regressions.

### Step 3.8 — Commit

```bash
git add packages/agentchat/src/cli/dispatch-handoff.ts \
        packages/agentchat/src/cli/auto-loop.ts \
        packages/agentchat/test/cli/dispatch-handoff.test.ts
git commit -m "refactor(agentchat): extract dispatchHandoff single-hop primitive shared by bin and (forthcoming) worker"
```

- [ ] **Step 3.8:** Commit.

---

## Task 4 — `POST /handoffs/<id>/claim` route

**Wave:** B &nbsp; **Depends:** —

**Files:**
- Modify: `packages/daemon/src/routes/handoffs.ts` (add `handoffsClaimRoute`)
- Modify: `packages/daemon/src/serve.ts` (wire route)
- Test: `packages/daemon/test/routes/handoffs.test.ts`

### Step 4.1 — Failing tests

Add to `packages/daemon/test/routes/handoffs.test.ts`:

```ts
import { handoffsClaimRoute } from '../../src/routes/handoffs.js';

async function seedAndApprove(services: Services, db: Database): Promise<string> {
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);
  return create.handoff_id;
}

test('POST /handoffs/<id>/claim flips approved → dispatched and returns 200', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedAndApprove(services, db);

  const res = await handoffsClaimRoute(new Request(`http://x/handoffs/${id}/claim`, { method: 'POST' }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'dispatched' });
  const row = db.query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(id);
  expect(row?.status).toBe('dispatched');
});

test('POST /handoffs/<id>/claim a second time returns 409 with current_status', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedAndApprove(services, db);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST' }), id, services);

  const second = await handoffsClaimRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(second.status).toBe(409);
  const body = await second.json();
  expect(body.current_status).toBe('dispatched');
});

test('POST /handoffs/<id>/claim on unknown id returns 404', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsClaimRoute(new Request('http://x', { method: 'POST' }), 'h-nope', services);
  expect(res.status).toBe(404);
});

test('POST /handoffs/<id>/claim on a pending handoff returns 409 (not approved)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsClaimRoute(new Request('http://x', { method: 'POST' }), create.handoff_id, services);
  expect(res.status).toBe(409);
});
```

- [ ] **Step 4.1:** Add the four tests.

- [ ] **Step 4.2:** Run the test file. Expected: all four fail (route does not exist).

### Step 4.3 — Implement the route

Edit `packages/daemon/src/routes/handoffs.ts` — add at the bottom:

```ts
export async function handoffsClaimRoute(_req: Request, handoff_id: string, services: Services): Promise<Response> {
  const cur = services.handoffReader.get(handoff_id);
  if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  const won = services.handoffWriter.claimDispatch(handoff_id);
  if (!won) {
    const after = services.handoffReader.get(handoff_id);
    return json({
      error: { code: 'conflict', message: `handoff ${handoff_id} cannot be claimed (status=${after?.status ?? 'unknown'})` },
      current_status: after?.status ?? null,
    }, 409);
  }
  return json({ handoff_id, status: 'dispatched' });
}
```

The `Services` import is already available at the top of the file (via the existing imports). If TypeScript complains, add `import type { Services } from '@penumbra/core';` at the top.

- [ ] **Step 4.3:** Apply the route.

### Step 4.4 — Wire into serve

Edit `packages/daemon/src/serve.ts`. Add to the imports line:

```ts
import { handoffsCreateRoute, handoffsListPendingRoute, handoffsApproveRoute, handoffsClaimRoute } from './routes/handoffs.js';
```

In the `fetch` handler, add right after the approve match:

```ts
const claimMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/claim$/);
if (req.method === 'POST' && claimMatch) {
  return handoffsClaimRoute(req, claimMatch[1]!, opts.services);
}
```

- [ ] **Step 4.4:** Wire the route.

- [ ] **Step 4.5:** Run `bun test packages/daemon/test/routes/handoffs.test.ts`. Expected: green.

### Step 4.6 — Commit

```bash
git add packages/daemon/src/routes/handoffs.ts packages/daemon/src/serve.ts \
        packages/daemon/test/routes/handoffs.test.ts
git commit -m "feat(daemon): POST /handoffs/<id>/claim route (atomic approved→dispatched)"
```

- [ ] **Step 4.6:** Commit.

---

## Task 5 — `POST /handoffs/<id>/complete` route

**Wave:** B &nbsp; **Depends:** —

**Files:**
- Modify: `packages/daemon/src/routes/handoffs.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/handoffs.test.ts`

### Step 5.1 — Failing tests

Add:

```ts
import { handoffsCompleteRoute } from '../../src/routes/handoffs.js';

async function seedApproveClaim(services: Services): Promise<string> {
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST' }), create.handoff_id, services);
  return create.handoff_id;
}

test('POST /handoffs/<id>/complete flips dispatched → completed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedApproveClaim(services);

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'completed' });
  const row = db.query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(id);
  expect(row?.status).toBe('completed');
});

test('POST /handoffs/<id>/complete on a pending handoff returns 409', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), create.handoff_id, services);
  expect(res.status).toBe(409);
});

test('POST /handoffs/<id>/complete on unknown id returns 404', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), 'h-nope', services);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 5.1:** Add the three tests.

- [ ] **Step 5.2:** Run the test file. Expected: 3 fail.

### Step 5.3 — Implement the route

Add to `packages/daemon/src/routes/handoffs.ts`:

```ts
export async function handoffsCompleteRoute(_req: Request, handoff_id: string, services: Services): Promise<Response> {
  const cur = services.handoffReader.get(handoff_id);
  if (!cur) return json({ error: { code: 'not_found', message: `handoff ${handoff_id} does not exist` } }, 404);
  if (cur.status !== 'dispatched') {
    return json({
      error: { code: 'conflict', message: `handoff ${handoff_id} is ${cur.status}, not dispatched` },
      current_status: cur.status,
    }, 409);
  }
  services.handoffWriter.markCompleted(handoff_id);
  return json({ handoff_id, status: 'completed' });
}
```

- [ ] **Step 5.3:** Apply.

### Step 5.4 — Wire into serve

Edit `packages/daemon/src/serve.ts`:

```ts
// extend the import
import {
  handoffsCreateRoute, handoffsListPendingRoute, handoffsApproveRoute,
  handoffsClaimRoute, handoffsCompleteRoute,
} from './routes/handoffs.js';

// add inside fetch handler, after the claim match:
const completeMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/complete$/);
if (req.method === 'POST' && completeMatch) {
  return handoffsCompleteRoute(req, completeMatch[1]!, opts.services);
}
```

- [ ] **Step 5.4:** Wire.

- [ ] **Step 5.5:** Run the test file. Expected: green.

### Step 5.6 — Commit

```bash
git add packages/daemon/src/routes/handoffs.ts packages/daemon/src/serve.ts \
        packages/daemon/test/routes/handoffs.test.ts
git commit -m "feat(daemon): POST /handoffs/<id>/complete route (dispatched→completed)"
```

- [ ] **Step 5.6:** Commit.

---

## Task 6 — `GET /handoffs/events` SSE route

**Wave:** B &nbsp; **Depends:** Task 2 (HandoffEventBus)

**Files:**
- Create: `packages/daemon/src/routes/handoffs-events.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/handoffs-events.test.ts`

### Step 6.1 — Failing test

Create `packages/daemon/test/routes/handoffs-events.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  buildServices, loadSqliteVec, migrate, type Services,
} from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { handoffsEventsRoute } from '../../src/routes/handoffs-events.js';
import { handoffsCreateRoute, handoffsApproveRoute } from '../../src/routes/handoffs.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {}, input: {}, storageRoot: '/tmp/sse-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: (() => { let n = 0; return () => `e-${++n}`; })(),
  });
}

async function readSseEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1000): Promise<any[]> {
  const reader = stream.getReader();
  const events: any[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), deadline - Date.now())),
    ]);
    if (done) break;
    if (!value) continue;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
    }
  }
  reader.releaseLock();
  return events;
}

test('GET /handoffs/events delivers approved-handoff events to subscribers', async () => {
  const services = tempServices();
  const res = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');

  // seed one handoff and approve it after the stream is open
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);

  const events = await readSseEvents(res.body!, 1);
  expect(events.length).toBe(1);
  expect(events[0].handoff_id).toBe(create.handoff_id);
  expect(events[0].status).toBe('approved');
});

test('GET /handoffs/events does not replay events emitted before connect', async () => {
  const services = tempServices();
  // Emit BEFORE subscribing
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);

  const res = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);
  const events = await readSseEvents(res.body!, 1, 200);
  expect(events.length).toBe(0);
});

test('GET /handoffs/events fans out to multiple subscribers', async () => {
  const services = tempServices();
  const r1 = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);
  const r2 = await handoffsEventsRoute(new Request('http://x/handoffs/events'), services);

  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);

  const [a, b] = await Promise.all([readSseEvents(r1.body!, 1), readSseEvents(r2.body!, 1)]);
  expect(a[0].handoff_id).toBe(create.handoff_id);
  expect(b[0].handoff_id).toBe(create.handoff_id);
});
```

- [ ] **Step 6.1:** Add the test file.

- [ ] **Step 6.2:** Run it. Expected: import error / route not found.

### Step 6.3 — Implement the SSE route

Create `packages/daemon/src/routes/handoffs-events.ts`:

```ts
import type { Services } from '@penumbra/core';

export async function handoffsEventsRoute(_req: Request, services: Services): Promise<Response> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const off = services.handoffEvents.subscribe((row) => {
        try {
          controller.enqueue(encoder.encode(`event: handoff\ndata: ${JSON.stringify(row)}\n\n`));
        } catch {
          // controller closed; unsubscribe defensively
          off();
        }
      });
      // Initial comment so clients know the connection is live (some HTTP buffers need a flush).
      controller.enqueue(encoder.encode(': ok\n\n'));
      // Cleanup is owned by the stream's cancel() below.
      (controller as any).__off = off;
    },
    cancel() {
      const off = (this as any).__off as (() => void) | undefined;
      try { off?.(); } catch { /* noop */ }
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

- [ ] **Step 6.3:** Create the file.

### Step 6.4 — Wire into serve

Edit `packages/daemon/src/serve.ts`:

```ts
import { handoffsEventsRoute } from './routes/handoffs-events.js';

// inside fetch, before the /handoffs GET match:
if (req.method === 'GET' && url.pathname === '/handoffs/events') {
  return handoffsEventsRoute(req, opts.services);
}
```

- [ ] **Step 6.4:** Wire.

- [ ] **Step 6.5:** Run `bun test packages/daemon/test/routes/handoffs-events.test.ts`. Expected: all 3 green. If timing-sensitive on slow machines, increase the readSseEvents timeout to 2000ms.

### Step 6.6 — Commit

```bash
git add packages/daemon/src/routes/handoffs-events.ts \
        packages/daemon/src/serve.ts \
        packages/daemon/test/routes/handoffs-events.test.ts
git commit -m "feat(daemon): GET /handoffs/events SSE stream (no replay)"
```

- [ ] **Step 6.6:** Commit.

---

## Task 7 — `POST /chains/start` route

**Wave:** B &nbsp; **Depends:** Task 1 (schema), Task 2 (event bus)

**Files:**
- Create: `packages/core/src/schemas/chain.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/writers/handoff.ts` (add `createApproved` for chain-start)
- Create: `packages/daemon/src/routes/chains.ts`
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/routes/chains.test.ts`

### Step 7.1 — Schema

Create `packages/core/src/schemas/chain.ts`:

```ts
import { z } from 'zod';
import { SafeProjectIdSchema } from './project-id.js';

export const ChainStartRequestSchema = z.object({
  initial_agent: z.string().min(1),
  message: z.string().min(1),
  conversation_id: z.string().min(1).optional(),
  project_id: SafeProjectIdSchema.nullable().optional(),
  max_hops: z.number().int().positive().optional(),
  trust_mode: z.enum(['all', 'config']).optional(),
});
export type ChainStartRequest = z.infer<typeof ChainStartRequestSchema>;
```

- [ ] **Step 7.1:** Create the schema.

- [ ] **Step 7.2:** Add to `packages/core/src/index.ts`:

```ts
export { ChainStartRequestSchema, type ChainStartRequest } from './schemas/chain.js';
```

### Step 7.3 — Failing test for `createApproved`

Add to `packages/core/test/writers/handoff.test.ts`:

```ts
test('HandoffWriter.createApproved inserts a handoff already in approved status with chain_* columns', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const bus = new HandoffEventBus();
  const writer = new HandoffWriter({ db, events: bus });
  const seen: any[] = [];
  bus.subscribe((row) => seen.push(row));

  writer.createApproved({
    handoff_id: 'h-cs', ts: '2026-04-26T00:00:00Z',
    project_id: 'auth', conversation_id: 'c1',
    from: 'user', to: 'planner', to_role: null,
    message: 'go', triggered_by_event_id: 'e-up',
    resolved_by: 'chain-start', resolved_at: '2026-04-26T00:00:00Z',
    chain_max_hops: 5, chain_trust_mode: 'all',
  });

  const row = db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get('h-cs');
  expect(row.status).toBe('approved');
  expect(row.from_agent).toBe('user');
  expect(row.resolved_by).toBe('chain-start');
  expect(row.chain_max_hops).toBe(5);
  expect(row.chain_trust_mode).toBe('all');
  expect(seen.length).toBe(1);
  expect(seen[0].handoff_id).toBe('h-cs');
});
```

- [ ] **Step 7.3:** Add test.

- [ ] **Step 7.4:** Run it. Expected: fail (`createApproved` undefined).

### Step 7.5 — Implement `createApproved`

Edit `packages/core/src/writers/handoff.ts`. Add:

```ts
export interface CreateApprovedParams {
  handoff_id: string;
  ts: string;
  project_id: string | null;
  conversation_id: string;
  from: string;
  to: string;
  to_role: string | null;
  message: string;
  triggered_by_event_id: string | null;
  resolved_by: string;
  resolved_at: string;
  chain_max_hops: number | null;
  chain_trust_mode: 'all' | 'config' | null;
}
```

And in the class body, after `create()`:

```ts
createApproved(params: CreateApprovedParams): string {
  this.db
    .query<unknown, [string, string, string | null, string, string, string, string | null, string, string, string, string, number | null, string | null, string | null]>(
      `INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id,
        from_agent, to_agent, to_role, message, status,
        resolved_by, resolved_at, chain_max_hops, chain_trust_mode, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
    )
    .run(
      params.handoff_id, params.ts, params.project_id, params.conversation_id,
      params.from, params.to, params.to_role, params.message,
      params.resolved_by, params.resolved_at,
      params.chain_max_hops, params.chain_trust_mode, params.triggered_by_event_id,
    );
  if (this.events) {
    const row = this.db.query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(params.handoff_id);
    if (row) this.events.emit(row);
  }
  return params.handoff_id;
}
```

Re-export the new param type from `index.ts`:

```ts
export {
  HandoffWriter,
  type CreateHandoffParams, type CreateApprovedParams,
  type ApproveOpts, type ApproveResult,
} from './writers/handoff.js';
```

- [ ] **Step 7.5:** Apply.

- [ ] **Step 7.6:** Run the writer test file. Expected: green.

### Step 7.7 — Failing tests for `/chains/start`

Create `packages/daemon/test/routes/chains.test.ts`:

```ts
import { expect, test } from 'bun:test';
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
  return buildServices({
    env: {}, input: {}, storageRoot: '/tmp/chains-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
}

test('POST /chains/start writes user-prompt event + approved handoff and returns ids', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', project_id: 'auth-svc', max_hops: 5, trust_mode: 'all' }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.conversation_id).toBe('string');
  expect(typeof body.handoff_id).toBe('string');

  const t0Row = services.db.query<any, [string]>(`SELECT * FROM t0_events WHERE event_id=?`).get(body.handoff_id) ?? null;
  // The user-prompt event_id is body.handoff_id's predecessor — we wrote both in one tx.
  // Check counts instead.
  const events = services.db.query<{ event_type: string }, []>(`SELECT event_type FROM t0_events`).all();
  expect(events.find((e) => e.event_type === 'user-prompt')).toBeDefined();

  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.status).toBe('approved');
  expect(handoff.from_agent).toBe('user');
  expect(handoff.to_agent).toBe('planner');
  expect(handoff.resolved_by).toBe('chain-start');
  expect(handoff.chain_max_hops).toBe(5);
  expect(handoff.chain_trust_mode).toBe('all');
  expect(handoff.conversation_id).toBe(body.conversation_id);
});

test('POST /chains/start honors caller-supplied conversation_id', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', conversation_id: 'conv-mine' }) }),
    services);
  const body = await res.json();
  expect(body.conversation_id).toBe('conv-mine');
});

test('POST /chains/start returns 400 for invalid body', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ message: 'hi' }) }), services);
  expect(res.status).toBe(400);
});

test('POST /chains/start emits exactly one handoff-events event for the new approved row', async () => {
  const services = tempServices();
  const seen: any[] = [];
  services.handoffEvents.subscribe((row) => seen.push(row));

  await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }) }), services);

  expect(seen.length).toBe(1);
  expect(seen[0].status).toBe('approved');
});
```

- [ ] **Step 7.7:** Add the test file.

- [ ] **Step 7.8:** Run it. Expected: all fail (`chainsStartRoute` does not exist).

### Step 7.9 — Implement the route

Create `packages/daemon/src/routes/chains.ts`:

```ts
import type { Services } from '@penumbra/core';
import { ChainStartRequestSchema } from '@penumbra/core';

export async function chainsStartRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  const parsed = ChainStartRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const conversation_id = parsed.data.conversation_id ?? `conv-${services.uuid()}`;
  const user_prompt_event_id = services.uuid();
  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();

  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: user_prompt_event_id,
      ts, ingest_ts: ts,
      source: 'agentchat',
      source_detail: 'chain-start',
      project_id: parsed.data.project_id ?? null,
      user_id: 'local-user',
      machine_id: services.machineId.get(),
      session_id: conversation_id,
      event_type: 'user-prompt',
      lane: 'cli-subscription',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: { prompt: parsed.data.message },
      payload_summary: parsed.data.message.slice(0, 240),
    });

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
    });
  })();

  return json({ conversation_id, handoff_id });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
```

- [ ] **Step 7.9:** Create the file.

- [ ] **Step 7.10:** Wire into `packages/daemon/src/serve.ts`:

```ts
import { chainsStartRoute } from './routes/chains.js';

// inside fetch:
if (req.method === 'POST' && url.pathname === '/chains/start') {
  return chainsStartRoute(req, opts.services);
}
```

- [ ] **Step 7.11:** Run `bun test packages/daemon/test/routes/chains.test.ts`. Expected: green.

### Step 7.12 — Commit

```bash
git add packages/core/src/schemas/chain.ts packages/core/src/index.ts \
        packages/core/src/writers/handoff.ts packages/core/test/writers/handoff.test.ts \
        packages/daemon/src/routes/chains.ts packages/daemon/src/serve.ts \
        packages/daemon/test/routes/chains.test.ts
git commit -m "feat(core,daemon): POST /chains/start endpoint and HandoffWriter.createApproved"
```

- [ ] **Step 7.12:** Commit.

---

## Task 8 — Extend `PenumbraClient` with new endpoints

**Wave:** B &nbsp; **Depends:** Tasks 4, 5, 6, 7 (route shape contracts)

**Files:**
- Modify: `packages/agentchat/src/penumbra-client.ts`
- Test: `packages/agentchat/test/penumbra-client.test.ts`

### Step 8.1 — Failing test (HTTP-level, against a real daemon helper)

Add to `packages/agentchat/test/penumbra-client.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { serve } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../src/penumbra-client.js';

function withDaemon(): { client: PenumbraClient; services: Services; stop: () => void; storageRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {}, input: {}, storageRoot: dir, db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  const handle = serve({ services, token: 'tok', port: 0 });
  writeFileSync(join(dir, 'port'), String(handle.port));
  writeFileSync(join(dir, 'token'), 'tok');
  return {
    client: new PenumbraClient({ storageRoot: dir }),
    services,
    storageRoot: dir,
    stop() { handle.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('PenumbraClient.startChain calls /chains/start', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const res = await client.startChain({ initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all' });
    expect(typeof res.conversation_id).toBe('string');
    expect(typeof res.handoff_id).toBe('string');
    const row = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(res.handoff_id);
    expect(row.status).toBe('approved');
  } finally { stop(); }
});

test('PenumbraClient.claimHandoff returns 200 on success and rejects on conflict', async () => {
  const { client, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    const claim = await client.claimHandoff(start.handoff_id);
    expect(claim.status).toBe('dispatched');
    await expect(client.claimHandoff(start.handoff_id)).rejects.toThrow(/409|conflict/i);
  } finally { stop(); }
});

test('PenumbraClient.completeHandoff flips dispatched → completed', async () => {
  const { client, services, stop } = withDaemon();
  try {
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    await client.claimHandoff(start.handoff_id);
    const res = await client.completeHandoff(start.handoff_id);
    expect(res.status).toBe('completed');
    const row = services.db.query<any, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(start.handoff_id);
    expect(row.status).toBe('completed');
  } finally { stop(); }
});

test('PenumbraClient.listHandoffs(status=approved,dispatched) returns matching rows', async () => {
  const { client, stop } = withDaemon();
  try {
    const a = await client.startChain({ initial_agent: 'planner', message: 'hi 1' });
    const b = await client.startChain({ initial_agent: 'planner', message: 'hi 2' });
    await client.claimHandoff(a.handoff_id);
    const r = await client.listHandoffs({ statuses: ['approved', 'dispatched'] });
    const ids = r.handoffs.map((h: any) => h.handoff_id).sort();
    expect(ids).toEqual([a.handoff_id, b.handoff_id].sort());
  } finally { stop(); }
});

test('PenumbraClient.subscribeHandoffEvents yields each approved handoff', async () => {
  const { client, stop } = withDaemon();
  try {
    const it = client.subscribeHandoffEvents();
    const first = it[Symbol.asyncIterator]().next();
    const start = await client.startChain({ initial_agent: 'planner', message: 'hi' });
    const event = await Promise.race([
      first,
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 1000)),
    ]);
    expect((event as any).value).toBeDefined();
    expect((event as any).value.handoff_id).toBe(start.handoff_id);
    await it.return?.();
  } finally { stop(); }
});
```

- [ ] **Step 8.1:** Add the tests.

- [ ] **Step 8.2:** Run them. Expected: all fail (methods don't exist).

### Step 8.3 — Implement client methods

Edit `packages/agentchat/src/penumbra-client.ts`. Replace the class:

```ts
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
  async listHandoffs(opts: { statuses: string[]; conversation_id?: string }): Promise<{ handoffs: any[] }> {
    const params = new URLSearchParams();
    params.set('status', opts.statuses.join(','));
    if (opts.conversation_id) params.set('conversation_id', opts.conversation_id);
    return this.get(`/handoffs?${params.toString()}`);
  }
  async approve(id: string, body: { redirect_to?: string; reject?: boolean; reason?: string; resolved_by?: string } = {}): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/approve`, body);
  }
  async claimHandoff(id: string): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/claim`, {});
  }
  async completeHandoff(id: string): Promise<{ handoff_id: string; status: string }> {
    return this.post(`/handoffs/${id}/complete`, {});
  }
  async startChain(body: {
    initial_agent: string; message: string;
    conversation_id?: string; project_id?: string | null;
    max_hops?: number; trust_mode?: 'all' | 'config';
  }): Promise<{ conversation_id: string; handoff_id: string }> {
    return this.post('/chains/start', body);
  }
  async *subscribeHandoffEvents(opts: { signal?: AbortSignal } = {}): AsyncIterable<any> {
    const { baseUrl, token } = this.resolve();
    const res = await fetch(`${baseUrl}/handoffs/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new Error(`penumbra /handoffs/events: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) yield JSON.parse(dataLine.slice(6));
        }
      }
    } finally {
      reader.releaseLock();
      try { await res.body.cancel(); } catch { /* noop */ }
    }
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

- [ ] **Step 8.3:** Replace the class.

- [ ] **Step 8.4:** Run `bun test packages/agentchat/test/penumbra-client.test.ts`. Expected: green.

### Step 8.5 — Commit

```bash
git add packages/agentchat/src/penumbra-client.ts \
        packages/agentchat/test/penumbra-client.test.ts
git commit -m "feat(agentchat): PenumbraClient methods for chains/start, claim, complete, listHandoffs, subscribeHandoffEvents"
```

- [ ] **Step 8.5:** Commit.

---

## Task 9 — Worker event-source (SSE + poll fallback + dedupe)

**Wave:** C &nbsp; **Depends:** Task 8

**Files:**
- Create: `packages/agentchat/src/worker/event-source.ts`
- Create: `packages/agentchat/test/worker/event-source.test.ts`

### Step 9.1 — Failing tests

Create `packages/agentchat/test/worker/event-source.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { startEventSource, type EventSourceClient } from '../../src/worker/event-source.js';

function makeClient(overrides: Partial<EventSourceClient> = {}): EventSourceClient {
  return {
    listHandoffs: mock().mockResolvedValue({ handoffs: [] }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      // never yields; pretend SSE is alive but quiet
      await new Promise<void>(() => {});
      // unreachable
    }),
    ...overrides,
  };
}

test('drains backlog from listHandoffs(status=approved,redirected) on startup', async () => {
  const handler = mock();
  const client = makeClient({
    listHandoffs: mock().mockResolvedValue({
      handoffs: [{ handoff_id: 'a', status: 'approved' }, { handoff_id: 'b', status: 'redirected' }],
    }),
  });
  const stop = startEventSource({ client, statuses: ['approved', 'redirected'], onEvent: handler, pollIntervalMs: 50 });
  await new Promise((r) => setTimeout(r, 30));
  expect(handler).toHaveBeenCalledTimes(2);
  expect(handler.mock.calls.map((c) => c[0].handoff_id).sort()).toEqual(['a', 'b']);
  await stop();
});

test('SSE events are delivered to handler', async () => {
  const handler = mock();
  const client = makeClient({
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      yield { handoff_id: 'sse-1', status: 'approved' };
      yield { handoff_id: 'sse-2', status: 'approved' };
      // hold open
      await new Promise<void>(() => {});
    }),
  });
  const stop = startEventSource({ client, statuses: ['approved'], onEvent: handler, pollIntervalMs: 1000 });
  await new Promise((r) => setTimeout(r, 60));
  expect(handler).toHaveBeenCalledTimes(2);
  await stop();
});

test('dedupes by handoff_id across SSE + poll', async () => {
  const handler = mock();
  let pollCount = 0;
  const client = makeClient({
    listHandoffs: mock().mockImplementation(async () => {
      pollCount++;
      return { handoffs: [{ handoff_id: 'x', status: 'approved' }] };
    }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      yield { handoff_id: 'x', status: 'approved' };
      await new Promise<void>(() => {});
    }),
  });
  const stop = startEventSource({ client, statuses: ['approved'], onEvent: handler, pollIntervalMs: 30 });
  await new Promise((r) => setTimeout(r, 100));
  // Even though SSE emits 'x' AND polling sees 'x' multiple times, handler runs once.
  expect(handler).toHaveBeenCalledTimes(1);
  await stop();
});

test('SSE error switches to polling and resumes when SSE recovers', async () => {
  const handler = mock();
  let sseAttempt = 0;
  const client = makeClient({
    listHandoffs: mock().mockResolvedValue({ handoffs: [{ handoff_id: 'p', status: 'approved' }] }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      sseAttempt++;
      if (sseAttempt === 1) throw new Error('boom');
      yield { handoff_id: 'sse-after-recover', status: 'approved' };
      await new Promise<void>(() => {});
    }),
  });
  const stop = startEventSource({
    client, statuses: ['approved'], onEvent: handler,
    pollIntervalMs: 30, sseBackoffStartMs: 5,
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(sseAttempt).toBeGreaterThanOrEqual(2);
  const ids = handler.mock.calls.map((c) => c[0].handoff_id);
  expect(ids).toContain('p');
  expect(ids).toContain('sse-after-recover');
  await stop();
});

test('stop() cancels SSE iterator and stops polling', async () => {
  const handler = mock();
  const client = makeClient();
  const stop = startEventSource({ client, statuses: ['approved'], onEvent: handler, pollIntervalMs: 10 });
  await new Promise((r) => setTimeout(r, 25));
  await stop();
  const callsBefore = handler.mock.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(handler.mock.calls.length).toBe(callsBefore);
});
```

- [ ] **Step 9.1:** Add the tests.

- [ ] **Step 9.2:** Run. Expected: all fail (module missing).

### Step 9.3 — Implement event source

Create `packages/agentchat/src/worker/event-source.ts`:

```ts
export interface EventSourceClient {
  listHandoffs(opts: { statuses: string[] }): Promise<{ handoffs: any[] }>;
  subscribeHandoffEvents(opts?: { signal?: AbortSignal }): AsyncIterable<any>;
}

export interface EventSourceOpts {
  client: EventSourceClient;
  statuses: string[];
  onEvent: (row: any) => void;
  pollIntervalMs: number;
  /** Initial SSE reconnect delay; doubles up to a 5s cap. Default 500ms. */
  sseBackoffStartMs?: number;
  /** Cap on SSE reconnect delay. Default 5000ms. */
  sseBackoffCapMs?: number;
}

export function startEventSource(opts: EventSourceOpts): () => Promise<void> {
  const seen = new Set<string>();
  const startMs = opts.sseBackoffStartMs ?? 500;
  const capMs = opts.sseBackoffCapMs ?? 5000;

  let stopped = false;
  let abort = new AbortController();
  let sseAlive = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const fanOut = (row: any) => {
    if (!row?.handoff_id) return;
    if (seen.has(row.handoff_id)) return;
    seen.add(row.handoff_id);
    try { opts.onEvent(row); } catch { /* one bad handler must not kill the loop */ }
  };

  const poll = async () => {
    if (stopped) return;
    if (!sseAlive) {
      try {
        const { handoffs } = await opts.client.listHandoffs({ statuses: opts.statuses });
        for (const h of handoffs) fanOut(h);
      } catch { /* swallow; we'll retry next tick */ }
    }
    if (!stopped) pollTimer = setTimeout(poll, opts.pollIntervalMs);
  };
  void poll();

  const sseLoop = async () => {
    let backoff = startMs;
    while (!stopped) {
      try {
        sseAlive = true;
        for await (const ev of opts.client.subscribeHandoffEvents({ signal: abort.signal })) {
          if (stopped) break;
          fanOut(ev);
        }
        sseAlive = false;
      } catch {
        sseAlive = false;
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, capMs);
    }
  };
  void sseLoop();

  return async () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    abort.abort();
  };
}
```

- [ ] **Step 9.3:** Create.

- [ ] **Step 9.4:** Run `bun test packages/agentchat/test/worker/event-source.test.ts`. Expected: green.

### Step 9.5 — Commit

```bash
git add packages/agentchat/src/worker/event-source.ts \
        packages/agentchat/test/worker/event-source.test.ts
git commit -m "feat(agentchat): worker event-source with SSE + poll fallback + dedupe"
```

- [ ] **Step 9.5:** Commit.

---

## Task 10 — Worker dispatcher (per-conversation lock + global concurrency)

**Wave:** C &nbsp; **Depends:** Task 3 (`dispatchHandoff`), Task 8 (client)

**Files:**
- Create: `packages/agentchat/src/worker/dispatcher.ts`
- Create: `packages/agentchat/test/worker/dispatcher.test.ts`

### Step 10.1 — Failing tests

Create `packages/agentchat/test/worker/dispatcher.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { createWorkerDispatcher, type WorkerDispatcherDeps } from '../../src/worker/dispatcher.js';

const baseHandoff = (id: string, conv = 'c1') => ({
  handoff_id: id, ts: 't', project_id: null, conversation_id: conv,
  from_agent: 'planner', to_agent: 'executor', to_role: null, message: 'm',
  status: 'approved', resolved_by: null, resolved_at: null, redirected_to: null,
  triggered_by_event_id: null, chain_max_hops: null, chain_trust_mode: null,
});

function deps(over: Partial<WorkerDispatcherDeps> = {}): WorkerDispatcherDeps {
  return {
    claim: mock().mockResolvedValue({ status: 'dispatched' }),
    dispatch: mock().mockResolvedValue({ next: null, terminatedReason: 'no_mention', text: '', agent: 'executor' }),
    log: { info: () => {}, warn: () => {}, debug: () => {} } as any,
    concurrency: 4,
    ...over,
  };
}

test('claim called once per event; dispatch called once on success', async () => {
  const d = deps();
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();
  expect(d.claim).toHaveBeenCalledTimes(1);
  expect(d.dispatch).toHaveBeenCalledTimes(1);
});

test('lost claim race (claim throws 409): dispatch is NOT called; no rethrow', async () => {
  const d = deps({ claim: mock().mockRejectedValue(new Error('penumbra /handoffs/h1/claim: HTTP 409')) });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1'));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
});

test('two handoffs for same conversation are serialized', async () => {
  let inflight = 0; let maxInflight = 0;
  const d = deps({
    dispatch: mock().mockImplementation(async () => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { next: null, terminatedReason: 'no_mention', text: '', agent: 'x' };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await Promise.all([dispatcher.handle(baseHandoff('h1', 'cA')), dispatcher.handle(baseHandoff('h2', 'cA'))]);
  await dispatcher.idle();
  expect(maxInflight).toBe(1);
  expect(d.dispatch).toHaveBeenCalledTimes(2);
});

test('cross-conversation dispatch parallelizes up to concurrency cap', async () => {
  let inflight = 0; let maxInflight = 0;
  const d = deps({
    concurrency: 2,
    dispatch: mock().mockImplementation(async () => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { next: null, terminatedReason: 'no_mention', text: '', agent: 'x' };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await Promise.all([
    dispatcher.handle(baseHandoff('h1', 'cA')),
    dispatcher.handle(baseHandoff('h2', 'cB')),
    dispatcher.handle(baseHandoff('h3', 'cC')),
  ]);
  await dispatcher.idle();
  expect(maxInflight).toBeLessThanOrEqual(2);
  expect(maxInflight).toBeGreaterThanOrEqual(2);
});

test('dispatch throw releases lock and semaphore; subsequent handoffs proceed', async () => {
  let calls = 0;
  const d = deps({
    dispatch: mock().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('adapter blew up');
      return { next: null, terminatedReason: 'no_mention', text: '', agent: 'x' };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff('h1', 'cA'));
  await dispatcher.handle(baseHandoff('h2', 'cA'));
  await dispatcher.idle();
  expect(d.dispatch).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 10.1:** Add tests.

- [ ] **Step 10.2:** Run. Expected: all fail (module missing).

### Step 10.3 — Implement dispatcher

Create `packages/agentchat/src/worker/dispatcher.ts`:

```ts
import type { Logger } from '@penumbra/core';
import type { DispatchHandoffResult } from '../cli/dispatch-handoff.js';

export interface WorkerDispatcherDeps {
  claim: (handoff_id: string) => Promise<{ status: string }>;
  dispatch: (handoff: any) => Promise<DispatchHandoffResult>;
  log: Logger;
  concurrency: number;
}

export interface WorkerDispatcher {
  handle(handoff: any): Promise<void>;
  /** Resolves once no in-flight or queued handoffs remain. */
  idle(): Promise<void>;
}

export function createWorkerDispatcher(deps: WorkerDispatcherDeps): WorkerDispatcher {
  const convLocks = new Map<string, Promise<void>>();
  let semaphore = deps.concurrency;
  const semaphoreWaiters: (() => void)[] = [];
  const inflight = new Set<Promise<void>>();

  const acquireSemaphore = (): Promise<void> => {
    if (semaphore > 0) { semaphore--; return Promise.resolve(); }
    return new Promise((resolve) => semaphoreWaiters.push(resolve));
  };
  const releaseSemaphore = () => {
    const next = semaphoreWaiters.shift();
    if (next) next();
    else semaphore++;
  };

  const acquireConvLock = async (conv: string): Promise<() => void> => {
    while (true) {
      const existing = convLocks.get(conv);
      if (!existing) break;
      await existing;
    }
    let release!: () => void;
    const p = new Promise<void>((r) => { release = r; });
    convLocks.set(conv, p);
    return () => {
      convLocks.delete(conv);
      release();
    };
  };

  const handleOne = async (handoff: any): Promise<void> => {
    const releaseLock = await acquireConvLock(handoff.conversation_id);
    await acquireSemaphore();
    try {
      try {
        await deps.claim(handoff.handoff_id);
      } catch (err) {
        deps.log.debug({ handoff_id: handoff.handoff_id, err: String(err) }, 'claim failed; skipping');
        return;
      }
      try {
        await deps.dispatch(handoff);
      } catch (err) {
        deps.log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'dispatch threw');
      }
    } finally {
      releaseSemaphore();
      releaseLock();
    }
  };

  return {
    async handle(handoff: any) {
      const p = handleOne(handoff);
      inflight.add(p);
      p.finally(() => inflight.delete(p));
      // Don't await p here — let the caller decide via idle().
    },
    async idle() {
      while (inflight.size > 0) {
        await Promise.allSettled(Array.from(inflight));
      }
    },
  };
}
```

- [ ] **Step 10.3:** Create.

- [ ] **Step 10.4:** Run `bun test packages/agentchat/test/worker/dispatcher.test.ts`. Expected: green.

### Step 10.5 — Commit

```bash
git add packages/agentchat/src/worker/dispatcher.ts \
        packages/agentchat/test/worker/dispatcher.test.ts
git commit -m "feat(agentchat): worker dispatcher with per-conversation lock and global concurrency"
```

- [ ] **Step 10.5:** Commit.

---

## Task 11 — `agentchat worker` bin entrypoint

**Wave:** C &nbsp; **Depends:** Tasks 3, 8, 9, 10

**Files:**
- Create: `packages/agentchat/bin/agentchat-worker.ts`
- Modify: `packages/agentchat/package.json` (add bin entry)
- Test: integration covered in Task 13.

### Step 11.1 — Create the worker bin

Create `packages/agentchat/bin/agentchat-worker.ts`:

```ts
#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { PenumbraClient } from '../src/penumbra-client.js';
import { dispatchHandoff } from '../src/cli/dispatch-handoff.js';
import { startEventSource } from '../src/worker/event-source.js';
import { createWorkerDispatcher } from '../src/worker/dispatcher.js';
import { createLogger } from '@penumbra/core';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return fallback;
}

const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
const storageRoot = flag('storage-root', process.env.PENUMBRA_STORAGE_ROOT ?? join(homedir(), '.penumbra'))!;
const concurrency = Number(flag('concurrency', '4'));
const pollIntervalMs = Number(flag('poll-interval', '1000'));
const defaultMaxHops = Number(flag('max-hops', '8'));
const defaultTrust = (flag('trust', 'all') as 'all' | 'config');
const transcriptBudget = Number(flag('transcript-budget', '8192'));

const log = createLogger({ component: 'agentchat-worker' });
const config = loadConfig(configPath);
const client = new PenumbraClient({ storageRoot });

function loadProjectContext(project_id: string | null): string | undefined {
  if (!project_id) return undefined;
  const path = join(storageRoot, 'context', project_id, 'latest.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

async function loadConversationTranscript(conversation_id: string): Promise<{ agent: string; text: string }[]> {
  // Phase 1: rebuild a simple transcript by listing prior completed handoffs in the conversation.
  // Each completed handoff carries the sender (from_agent) and message (the sender's reply text).
  // The user-prompt that started the chain is reconstructed from the very first handoff's message.
  const { handoffs } = await client.listHandoffs({
    statuses: ['completed', 'dispatched', 'approved', 'redirected'],
    conversation_id,
  });
  // Drop the chain-start synthetic handoff — its message IS the user prompt and should be the first transcript line.
  const sorted = [...handoffs].sort((a, b) => a.ts.localeCompare(b.ts));
  const transcript: { agent: string; text: string }[] = [];
  for (const h of sorted) {
    if (h.from_agent === 'user') {
      transcript.push({ agent: 'user', text: h.message });
    } else {
      transcript.push({ agent: h.from_agent, text: h.message });
    }
  }
  return transcript;
}

const dispatcher = createWorkerDispatcher({
  log,
  concurrency,
  claim: (id) => client.claimHandoff(id),
  dispatch: async (handoff) => {
    const transcript = await loadConversationTranscript(handoff.conversation_id);
    // Drop the current handoff's own message from the transcript — dispatchHandoff re-adds it via the wrapper.
    const transcriptForBuild = transcript.filter((t) => !(t.agent === handoff.from_agent && t.text === handoff.message));
    // Count prior hops: number of agent-response transcript entries (i.e., non-user).
    const hopsSoFar = transcript.filter((t) => t.agent !== 'user').length;

    const projectContext = loadProjectContext(handoff.project_id);
    const trustMode = (handoff.chain_trust_mode ?? defaultTrust) as 'all' | 'config';
    const maxHops = handoff.chain_max_hops ?? defaultMaxHops;

    const result = await dispatchHandoff({
      handoff,
      config,
      conversation: { id: handoff.conversation_id, project_id: handoff.project_id ?? null },
      transcript: transcriptForBuild,
      transcriptBudget,
      hopsSoFar,
      maxHops,
      trustMode,
      projectContext,
      observe: (e) => client.observe(e),
      createHandoff: (body) => client.createHandoff(body),
      approve: (id, body) => client.approve(id, body),
    });

    // Always mark the dispatched handoff completed once the hop finishes (success or terminal).
    try { await client.completeHandoff(handoff.handoff_id); }
    catch (err) { log.warn({ handoff_id: handoff.handoff_id, err: String(err) }, 'completeHandoff failed'); }

    return result;
  },
});

const stop = startEventSource({
  client: {
    listHandoffs: (o) => client.listHandoffs(o),
    subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
  },
  statuses: ['approved', 'redirected'],
  pollIntervalMs,
  onEvent: (row) => { void dispatcher.handle(row); },
});

log.info({ storageRoot, concurrency, pollIntervalMs, defaultMaxHops, defaultTrust }, 'agentchat worker started');

const shutdown = async (sig: string) => {
  log.info({ sig }, 'shutting down');
  await stop();
  await dispatcher.idle();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

- [ ] **Step 11.1:** Create the file.

### Step 11.2 — Register the bin

Edit `packages/agentchat/package.json` — replace the `bin` block:

```json
"bin": {
  "agentchat": "./bin/agentchat.ts",
  "agentchat-worker": "./bin/agentchat-worker.ts"
}
```

- [ ] **Step 11.2:** Apply.

### Step 11.3 — Smoke check the entrypoint compiles

Run:

```bash
bun run packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/nonexistent-penumbra-x 2>&1 | head -5
```

Expected: prints a structured log line about start, then errors out trying to resolve the daemon (port file missing). Process exit is irrelevant; the goal is "no syntax / import errors."

- [ ] **Step 11.3:** Run the smoke check.

### Step 11.4 — Commit

```bash
git add packages/agentchat/bin/agentchat-worker.ts packages/agentchat/package.json
git commit -m "feat(agentchat): agentchat-worker bin entrypoint"
```

- [ ] **Step 11.4:** Commit.

---

## Task 12 — MCP `penumbra__chain_start` tool

**Wave:** D &nbsp; **Depends:** Task 7 (route), Task 8 (client method)

**Files:**
- Create: `packages/mcp/src/tools/chain-start.ts`
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/daemon-client.ts` (add `startChain` method matching the daemon route)
- Test: `packages/mcp/test/tools/chain-start.test.ts`

### Step 12.1 — Inspect existing tool patterns

Run:
```bash
ls /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/tools
cat /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/tools/handoff-approve.ts
cat /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/daemon-client.ts | head -40
```

Use this as the template for `chain-start.ts`. The handler receives a `DaemonClient` and must call its (forthcoming) `startChain` method.

- [ ] **Step 12.1:** Read the patterns.

### Step 12.2 — Failing test

Create `packages/mcp/test/tools/chain-start.test.ts`:

```ts
import { expect, test, mock } from 'bun:test';
import { chainStartHandler, ChainStartInputShape } from '../../src/tools/chain-start.js';

test('ChainStartInputShape requires initial_agent and message', () => {
  expect(() => (ChainStartInputShape as any).initial_agent.parse(undefined)).toThrow();
});

test('chain.start handler proxies to daemon.startChain and returns conversation_id + handoff_id', async () => {
  const daemon = {
    startChain: mock().mockResolvedValue({ conversation_id: 'conv-1', handoff_id: 'h-1' }),
  } as any;
  const handler = chainStartHandler(daemon);
  const res = await handler({ initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all' });
  expect(daemon.startChain).toHaveBeenCalledWith({
    initial_agent: 'planner', message: 'hi', max_hops: 5, trust_mode: 'all',
  });
  expect(res.content[0].type).toBe('text');
  const parsed = JSON.parse(res.content[0].text);
  expect(parsed).toEqual({ conversation_id: 'conv-1', handoff_id: 'h-1' });
});
```

- [ ] **Step 12.2:** Add.

- [ ] **Step 12.3:** Run. Expected: import error.

### Step 12.4 — Implement tool

Create `packages/mcp/src/tools/chain-start.ts` (use the same shape as `handoff-approve.ts`):

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ChainStartInputShape = {
  initial_agent: z.string().min(1).describe('The agent to receive the first hop of the chain'),
  message: z.string().min(1).describe('The user message that kicks off the chain'),
  conversation_id: z.string().min(1).optional().describe('Optional caller-supplied conversation id'),
  project_id: z.string().min(1).nullable().optional().describe('Optional project scope'),
  max_hops: z.number().int().positive().optional().describe('Maximum hop count (default 8)'),
  trust_mode: z.enum(['all', 'config']).optional().describe('all = auto-approve every edge; config = consult auto_approve_to'),
};

export function chainStartHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const res = await daemon.startChain({
      initial_agent: input.initial_agent,
      message: input.message,
      conversation_id: input.conversation_id,
      project_id: input.project_id ?? null,
      max_hops: input.max_hops,
      trust_mode: input.trust_mode,
    });
    return { content: [{ type: 'text', text: JSON.stringify(res) }] };
  };
}
```

- [ ] **Step 12.4:** Create.

### Step 12.5 — Add `startChain` to DaemonClient

Edit `packages/mcp/src/daemon-client.ts`. Add (next to existing methods):

```ts
async startChain(body: {
  initial_agent: string; message: string;
  conversation_id?: string; project_id?: string | null;
  max_hops?: number; trust_mode?: 'all' | 'config';
}): Promise<{ conversation_id: string; handoff_id: string }> {
  return this.post('/chains/start', body);
}
```

- [ ] **Step 12.5:** Apply.

### Step 12.6 — Wire into MCP server

Edit `packages/mcp/src/server.ts`. Add the import and registration:

```ts
import { ChainStartInputShape, chainStartHandler } from './tools/chain-start.js';

// inside buildServer, after the other registerTool calls:
server.registerTool(
  'chain.start',
  { description: 'Kick off an agentchat chain by sending a message to the initial agent. The worker dispatches the chain headlessly. Poll handoff.list_pending to monitor.', inputSchema: ChainStartInputShape },
  chainStartHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
```

- [ ] **Step 12.6:** Apply.

- [ ] **Step 12.7:** Run `bun test packages/mcp/test/tools/chain-start.test.ts`. Expected: green.

- [ ] **Step 12.8:** Run `bun test packages/mcp`. Expected: all green (no regressions).

### Step 12.9 — Commit

```bash
git add packages/mcp/src/tools/chain-start.ts \
        packages/mcp/src/daemon-client.ts \
        packages/mcp/src/server.ts \
        packages/mcp/test/tools/chain-start.test.ts
git commit -m "feat(mcp): chain.start tool wraps POST /chains/start"
```

- [ ] **Step 12.9:** Commit.

---

## Task 13 — Integration test: headless chain end-to-end

**Wave:** E &nbsp; **Depends:** Tasks 1–11

**Files:**
- Create: `packages/agentchat/test/integration/headless-chain.test.ts`
- (no production code in this task)

### Step 13.1 — Failing integration test

Create `packages/agentchat/test/integration/headless-chain.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, createLogger, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { serve } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../../src/penumbra-client.js';
import { dispatchHandoff } from '../../src/cli/dispatch-handoff.js';
import { startEventSource } from '../../src/worker/event-source.js';
import { createWorkerDispatcher } from '../../src/worker/dispatcher.js';
import { registerAdapter } from '../../src/adapters/registry.js';
import type { AgentChatConfig } from '../../src/config/types.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

test('headless POST /chains/start → worker dispatches a 2-hop chain → t0 trail matches a bin-driven chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-int-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services: Services = buildServices({
    env: {}, input: {}, storageRoot: dir, db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  const handle = serve({ services, token: 'tok', port: 0 });
  writeFileSync(join(dir, 'port'), String(handle.port));
  writeFileSync(join(dir, 'token'), 'tok');

  // Stub adapter: planner mentions @executor; executor replies plain.
  let plannerCalls = 0; let executorCalls = 0;
  registerAdapter('mock-int', () => ({
    kind: 'mock-int',
    async dispatch({ prompt }) {
      if (prompt.includes('From @planner')) { executorCalls++; return { text: 'executor done' }; }
      plannerCalls++;
      return { text: 'plan: @executor go' };
    },
  }));
  const config: AgentChatConfig = {
    agents: [
      { name: 'planner', adapter: 'mock-int', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
      { name: 'executor', adapter: 'mock-int', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: { planner: 'planner', executor: 'executor' },
  };

  const client = new PenumbraClient({ storageRoot: dir });
  const log = createLogger({ component: 'int-test' });

  const dispatcher = createWorkerDispatcher({
    log, concurrency: 1,
    claim: (id) => client.claimHandoff(id),
    dispatch: async (h) => {
      const transcript: { agent: string; text: string }[] = [];
      const { handoffs } = await client.listHandoffs({
        statuses: ['completed', 'dispatched', 'approved', 'redirected'], conversation_id: h.conversation_id,
      });
      for (const x of [...handoffs].sort((a, b) => a.ts.localeCompare(b.ts))) {
        if (x.handoff_id === h.handoff_id) continue;
        transcript.push({ agent: x.from_agent === 'user' ? 'user' : x.from_agent, text: x.message });
      }
      const hopsSoFar = transcript.filter((t) => t.agent !== 'user').length;
      const result = await dispatchHandoff({
        handoff: h, config,
        conversation: { id: h.conversation_id, project_id: h.project_id ?? null },
        transcript, transcriptBudget: 4096,
        hopsSoFar, maxHops: 5,
        trustMode: (h.chain_trust_mode ?? 'all') as 'all' | 'config',
        observe: (e) => client.observe(e),
        createHandoff: (body) => client.createHandoff(body),
        approve: (id, body) => client.approve(id, body),
      });
      try { await client.completeHandoff(h.handoff_id); } catch { /* may already be done */ }
      return result;
    },
  });
  const stop = startEventSource({
    client: {
      listHandoffs: (o) => client.listHandoffs(o),
      subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
    },
    statuses: ['approved', 'redirected'],
    pollIntervalMs: 50,
    onEvent: (row) => { void dispatcher.handle(row); },
  });

  try {
    const res = await client.startChain({ initial_agent: 'planner', message: 'go!', max_hops: 5, trust_mode: 'all' });

    // Poll for completion
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { handoffs } = await client.listHandoffs({
        statuses: ['pending', 'approved', 'dispatched'],
        conversation_id: res.conversation_id,
      });
      if (handoffs.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Assertions
    expect(plannerCalls).toBe(1);
    expect(executorCalls).toBe(1);

    const events = services.db.query<{ event_type: string; user_id: string }, []>(
      `SELECT event_type, user_id FROM t0_events WHERE session_id=? ORDER BY ts ASC`
    ).all(res.conversation_id);
    const types = events.map((e) => e.event_type);
    expect(types.filter((t) => t === 'user-prompt').length).toBe(1);
    expect(types.filter((t) => t === 'agent-prompt').length).toBe(2);
    expect(types.filter((t) => t === 'agent-response').length).toBe(2);
    expect(types.filter((t) => t === 'agent-handoff').length).toBe(1);

    const hand = services.db.query<{ status: string; from_agent: string; to_agent: string }, [string]>(
      `SELECT status, from_agent, to_agent FROM handoffs WHERE conversation_id=? ORDER BY ts ASC`
    ).all(res.conversation_id);
    expect(hand.every((h) => h.status === 'completed')).toBe(true);
  } finally {
    await stop();
    await dispatcher.idle();
    handle.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
```

- [ ] **Step 13.1:** Add the test.

- [ ] **Step 13.2:** Run `bun test packages/agentchat/test/integration/headless-chain.test.ts`. Expected: green. If timing-flaky, raise the deadline and pollIntervalMs.

### Step 13.3 — Commit

```bash
git add packages/agentchat/test/integration/headless-chain.test.ts
git commit -m "test(agentchat): headless POST /chains/start → worker → completion integration test"
```

- [ ] **Step 13.3:** Commit.

---

## Task 14 — Integration test: bin-coexistence claim race

**Wave:** E &nbsp; **Depends:** Task 13

**Files:**
- Create: `packages/agentchat/test/integration/worker-bin-coexistence.test.ts`

### Step 14.1 — Failing test

Create `packages/agentchat/test/integration/worker-bin-coexistence.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, createLogger, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { serve } from '@penumbra/daemon/src/serve.js';
import { PenumbraClient } from '../../src/penumbra-client.js';
import { runAutoChain } from '../../src/cli/auto-loop.js';
import { dispatchHandoff } from '../../src/cli/dispatch-handoff.js';
import { createWorkerDispatcher } from '../../src/worker/dispatcher.js';
import { startEventSource } from '../../src/worker/event-source.js';
import { registerAdapter } from '../../src/adapters/registry.js';
import type { AgentChatConfig } from '../../src/config/types.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

test('bin runAutoChain and worker race to dispatch the same approved handoff; claimDispatch ensures exactly one wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-coexist-'));
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services: Services = buildServices({
    env: {}, input: {}, storageRoot: dir, db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
  const handle = serve({ services, token: 'tok', port: 0 });
  writeFileSync(join(dir, 'port'), String(handle.port));
  writeFileSync(join(dir, 'token'), 'tok');

  registerAdapter('mock-coex', () => ({
    kind: 'mock-coex',
    async dispatch({ prompt }) { return { text: prompt.includes('From @planner') ? 'executor ok' : 'plan: @executor go' }; },
  }));
  const config: AgentChatConfig = {
    agents: [
      { name: 'planner', adapter: 'mock-coex', options: {}, roles: ['planner'], auto_approve_to: ['executor'] },
      { name: 'executor', adapter: 'mock-coex', options: {}, roles: ['executor'], auto_approve_to: [] },
    ],
    default_roles: { planner: 'planner', executor: 'executor' },
  };

  const client = new PenumbraClient({ storageRoot: dir });

  // Worker
  const dispatcher = createWorkerDispatcher({
    log: createLogger({ component: 't' }), concurrency: 1,
    claim: (id) => client.claimHandoff(id),
    dispatch: async (h) => {
      const result = await dispatchHandoff({
        handoff: h, config,
        conversation: { id: h.conversation_id, project_id: h.project_id ?? null },
        transcript: [], transcriptBudget: 4096,
        hopsSoFar: 0, maxHops: 5, trustMode: 'all',
        observe: (e) => client.observe(e),
        createHandoff: (body) => client.createHandoff(body),
        approve: (id, body) => client.approve(id, body),
      });
      try { await client.completeHandoff(h.handoff_id); } catch { /* may already be terminal */ }
      return result;
    },
  });
  const stop = startEventSource({
    client: {
      listHandoffs: (o) => client.listHandoffs(o),
      subscribeHandoffEvents: (o) => client.subscribeHandoffEvents(o),
    },
    statuses: ['approved', 'redirected'], pollIntervalMs: 25,
    onEvent: (row) => { void dispatcher.handle(row); },
  });

  try {
    const conv = { id: 'conv-coex-1', project_id: null };

    // Kick off via bin-style runAutoChain — it'll create+approve handoffs in-process.
    // The worker will see these via SSE/poll and may also try to dispatch.
    const binPromise = runAutoChain({
      config, initialAgent: 'planner', userMessage: 'race!', conversation: conv,
      maxHops: 3, transcriptBudget: 4096,
      observe: (e) => client.observe(e),
      createHandoff: (body) => client.createHandoff(body),
      approve: (id, body) => client.approve(id, body),
    });
    const binRes = await binPromise;

    // Allow the worker a brief window to also try to claim and lose
    await new Promise((r) => setTimeout(r, 100));

    expect(binRes.terminatedReason).toBe('no_mention');

    const responseEvents = services.db.query<{ payload_json: string }, [string]>(
      `SELECT payload_json FROM t0_events WHERE event_type='agent-response' AND session_id=?`
    ).all(conv.id);
    // Bin and worker may both observe agent-response; that's expected because the bin observes
    // its own dispatch events. The invariant is: NO handoff is dispatched twice (the bin races
    // the worker on the SAME approved handoff via claimDispatch). Verify by counting ROWS
    // that ever transitioned to 'dispatched' OR 'completed' is bounded by 1 per handoff.
    const handoffStates = services.db.query<{ status: string }, [string]>(
      `SELECT status FROM handoffs WHERE conversation_id=?`
    ).all(conv.id);
    // Every handoff ends in a terminal state; none are stuck at 'approved'.
    expect(handoffStates.every((h) => h.status === 'completed' || h.status === 'dispatched' || h.status === 'pending')).toBe(true);
    // There must be no double-dispatch: the bin logged exactly one set of agent-prompt/response per hop;
    // total agent-response rows match total bin hops (the bin is the canonical actor here because the
    // worker's claim attempts fail with 409).
    expect(responseEvents.length).toBe(binRes.hops);
  } finally {
    await stop();
    await dispatcher.idle();
    handle.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
```

- [ ] **Step 14.1:** Add.

- [ ] **Step 14.2:** Run. Expected: green. The key invariant: claim races resolve to "exactly one dispatcher wins per handoff"; the test asserts this by counting agent-response events.

### Step 14.3 — Commit

```bash
git add packages/agentchat/test/integration/worker-bin-coexistence.test.ts
git commit -m "test(agentchat): worker+bin coexistence claim race integration test"
```

- [ ] **Step 14.3:** Commit.

---

## Task 15 — README and docs

**Wave:** E &nbsp; **Depends:** Tasks 11, 12

**Files:**
- Modify: `packages/agentchat/README.md` (add a `Worker` section)

### Step 15.1 — Inspect current README

Run:
```bash
ls packages/agentchat/README.md && wc -l packages/agentchat/README.md
```

If absent, skip step. Otherwise:

- [x] **Step 15.1:** Locate the README.

### Step 15.2 — Add the Worker section

If the README exists, append a section like:

```markdown
## Daemon-driven worker (phase 1)

`agentchat-worker` is a long-running process that dispatches approved handoffs out-of-process. It enables headless chains: any caller can produce an approved handoff and the worker drives the chain to completion without a TTY.

Start it (one per machine):

    agentchat-worker --storage-root /tmp/penumbra-live --concurrency 4 --poll-interval 1000

Kick off a chain headlessly:

    curl -X POST http://localhost:<daemon-port>/chains/start \
      -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
      -H "content-type: application/json" \
      -d '{"initial_agent":"planner","message":"@executor: ping","max_hops":5,"trust_mode":"all"}'

The same kick-off is available as the MCP tool `chain.start` — useful for Claude Code, automation, etc.

Poll for completion:

    GET /handoffs?conversation_id=<id>&status=pending,approved,dispatched
    # empty result = chain idle

The interactive `agentchat new --auto` bin still dispatches in-process; bin and worker can coexist safely (`claimDispatch` ensures exactly-one). For maximum clarity, run only one against a given conversation at a time.
```

- [x] **Step 15.2:** Add the section.

### Step 15.3 — Commit

```bash
git add packages/agentchat/README.md
git commit -m "docs(agentchat): document daemon-driven worker and chain.start MCP tool"
```

- [x] **Step 15.3:** Commit.

---

## Final verification

- [ ] **Step F.1:** Run the full repo test suite from the workspace root:

```bash
bun test
```

Expected: pass count ≥ pre-change count + ~50 (8 dispatch-handoff + 4 listByStatus + 4 status filter + 4 events bus + 2 writer + 4 claim + 3 complete + 3 SSE + 4 chains + 5 client + 5 event-source + 5 dispatcher + 1 chain.start + 1 schema + 2 integration). Cosmetic Bun ONNX teardown panic at the end is expected; ignore.

- [ ] **Step F.2:** Manual smoke (document outcome in PR or session notes):
  1. `bun packages/cli/bin/penumbra.ts start --detach` (or restart the existing live daemon).
  2. `bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live` in a separate terminal.
  3. Trigger MCP `chain.start` (or hit `POST /chains/start` directly with curl) using `initial_agent='planner'`, message `"@executor: ping"`.
  4. Watch the worker log two dispatches (planner reply mentions executor → handoff approved → executor replies → no mention → done).
  5. `sqlite3 /tmp/penumbra-live/db.sqlite "select event_type from t0_events where session_id='<conv_id>' order by ts;"` — expect one `user-prompt`, two `agent-prompt`, two `agent-response`, one `agent-handoff`.

- [ ] **Step F.3:** Verify acceptance criteria from the spec:
  1. `agentchat-worker` runs and dispatches approved handoffs ✓
  2. `POST /chains/start` exists; MCP `chain.start` wraps it ✓
  3. `POST /handoffs/<id>/claim` is the worker's only path to dispatched ✓
  4. `GET /handoffs/events` SSE works; worker has poll fallback ✓
  5. Bin's `--auto` path unchanged; live streaming preserved (Step F.2 plus existing tests) ✓
  6. Headless smoke produces a t0 trail indistinguishable from bin-driven dispatch (Task 13) ✓
  7. Full test suite green (Step F.1) ✓

---

## Self-review checklist (run before declaring plan ready)

1. **Spec coverage:**
   - `POST /chains/start` → Task 7 ✓
   - `POST /handoffs/<id>/claim` → Task 4 ✓
   - `POST /handoffs/<id>/complete` → Task 5 ✓
   - `GET /handoffs/events` SSE → Task 6 ✓
   - `?status=` filter on `GET /handoffs` → Task 1 ✓
   - `chain_max_hops`, `chain_trust_mode` columns → Task 1 ✓
   - `HandoffEventBus` + writer integration → Task 2 ✓
   - `dispatchHandoff` extraction → Task 3 ✓
   - Worker event-source SSE+poll → Task 9 ✓
   - Worker dispatcher (lock + concurrency) → Task 10 ✓
   - `agentchat-worker` bin → Task 11 ✓
   - MCP `chain.start` tool → Task 12 ✓
   - Headless integration test → Task 13 ✓
   - Coexistence integration test → Task 14 ✓
   - README → Task 15 ✓

2. **Type consistency:**
   - `dispatchHandoff` returns `{ next, terminatedReason?, cappedHandoffId?, text, agent }` consistently in Task 3 source, Task 3 tests, Task 10 dispatcher tests, Task 11 worker bin, Task 13 integration.
   - `WorkerDispatcherDeps.dispatch` signature matches `(handoff: any) => Promise<DispatchHandoffResult>` in dispatcher.ts and worker bin.
   - `EventSourceClient.subscribeHandoffEvents` returns `AsyncIterable<any>` in event-source.ts and PenumbraClient.

3. **Placeholder scan:** none.
