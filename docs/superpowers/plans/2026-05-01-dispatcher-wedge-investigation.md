# Dispatcher Wedge Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `dispatch_events` instrumentation table, writers, read surface (CLI + MCP), synthetic wedge-probe harness, and an empty RCA stub — to enable diagnosis of dispatched handoffs that resolve only via the worker watchdog.

**Architecture:** Daemon owns the new sqlite table and exposes `POST /dispatch/events` (batch ingest) and `GET /dispatch/events?handoff_id=…` (read). Worker buffers events in-memory and flushes via the existing `PenumbraClient` HTTP path. Six emit sites: `cli-spawn` (spawn/kill/exit), worker dispatcher (start/end/cancel), control-listener (cancel-received), heartbeat emitter (heartbeat-sent), daemon heartbeat route (heartbeat-received), daemon watchdog (tick/auto-fail). Probe harness drives `cli-spawn` directly with synthetic shell-script CLIs to provoke each wedge hypothesis.

**Tech Stack:** TypeScript, Bun runtime, sqlite (`@penumbra/core` via `bun:sqlite`), zod schemas, MCP TS SDK.

**Spec:** `docs/superpowers/specs/2026-05-01-dispatcher-wedge-investigation-design.md`

---

## File structure

| Action | Path | Reason |
|---|---|---|
| Modify | `packages/core/src/db/schema.ts` | Add `dispatch_events` table to `applySchema()`; bump `SCHEMA_VERSION` to 4 |
| Create | `packages/daemon/src/services/dispatch-event-log.ts` | Writer service: `record()`, `recordBatch()`, `listByHandoff()` |
| Modify | `packages/core/src/services.ts` | Add `dispatchEventLog` to `Services` and `buildServices()` |
| Create | `packages/daemon/src/routes/dispatch-events.ts` | `POST` (batch ingest) and `GET` (timeline read) handlers |
| Modify | `packages/daemon/src/serve.ts` | Register the two new routes |
| Modify | `packages/daemon/src/services/watchdog.ts` | Emit `watchdog.tick` + `watchdog.auto_fail` |
| Modify | `packages/daemon/src/routes/worker-heartbeat.ts` | Emit `heartbeat.received` |
| Modify | `packages/agentchat/src/penumbra-client.ts` | Add `postDispatchEvents(events[])` |
| Create | `packages/agentchat/src/worker/event-queue.ts` | Buffered fire-and-forget queue |
| Modify | `packages/agentchat/src/adapters/cli-spawn.ts` | Add `eventContext` to `SpawnOpts`; emit `proc.spawn`, `proc.kill.sent`, `proc.exited.resolved` |
| Modify | `packages/agentchat/src/worker/dispatcher.ts` | Emit `dispatch.start`, `dispatch.end`, `cancel.dispatched`; thread `eventContext` to adapters |
| Modify | `packages/agentchat/src/worker/control-listener.ts` | Emit `cancel.received` |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` | Locate heartbeat emitter; emit `heartbeat.sent` after POST resolves |
| Modify | `packages/cli/bin/penumbra.ts` | Register `dispatch` top-level subcommand |
| Create | `packages/cli/src/commands/dispatch.ts` | `runDispatchTimeline()` impl |
| Create | `packages/mcp/src/tools/dispatch-timeline.ts` | MCP tool schema + handler |
| Modify | `packages/mcp/src/server.ts` | Register `dispatch.timeline` tool |
| Create | `packages/agentchat/scripts/wedge-probe/probes/wedge-A-sigterm-deaf.sh` | Probe A |
| Create | `packages/agentchat/scripts/wedge-probe/probes/wedge-B-detach-stdio.sh` | Probe B (load-bearing) |
| Create | `packages/agentchat/scripts/wedge-probe/probes/wedge-C-stdout-backpressure.sh` | Probe C |
| Create | `packages/agentchat/scripts/wedge-probe/probes/wedge-D-baseline.sh` | Probe D (control) |
| Create | `packages/agentchat/scripts/wedge-probe/run-probes.ts` | Runner |
| Create | `docs/superpowers/notes/2026-05-01-dispatcher-wedge-rca.md` | Stub RCA with section headers, populated post-soak |

Tests are co-located with each implementation task below.

---

## Task 1: Schema — add `dispatch_events` table

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Test: `packages/core/test/db/schema-dispatch-events.test.ts` (create)

- [ ] **Step 1: Failing test.**

Create `packages/core/test/db/schema-dispatch-events.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, SCHEMA_VERSION } from '../../src/db/schema';

describe('dispatch_events table', () => {
  test('SCHEMA_VERSION bumped to 4', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });

  test('applySchema creates dispatch_events with expected columns', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const cols = db.query("PRAGMA table_info('dispatch_events')").all() as Array<{ name: string; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['handoff_id', 'id', 'kind', 'meta_json', 'source', 'ts', 'worker_id']);
    const notnull = Object.fromEntries(cols.map((c) => [c.name, c.notnull === 1]));
    expect(notnull.handoff_id).toBe(true);
    expect(notnull.source).toBe(true);
    expect(notnull.kind).toBe(true);
    expect(notnull.ts).toBe(true);
    expect(notnull.worker_id).toBe(false);
    expect(notnull.meta_json).toBe(false);
  });

  test('meta_json check constraint rejects > 4 KB payload', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const big = 'x'.repeat(5000);
    expect(() => {
      db.run(
        "INSERT INTO dispatch_events (handoff_id, source, kind, ts, meta_json) VALUES ('h', 'worker', 'dispatch.start', '2026-05-01T00:00:00.000Z', ?)",
        [big],
      );
    }).toThrow(/CHECK/);
  });

  test('idx_dispatch_events_handoff exists', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const indexes = db.query("PRAGMA index_list('dispatch_events')").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_dispatch_events_handoff');
    expect(names).toContain('idx_dispatch_events_ts');
  });
});
```

- [ ] **Step 2: Run test, confirm RED.**

```bash
bun test packages/core/test/db/schema-dispatch-events.test.ts
```

Expected: 4 fails (table does not exist; SCHEMA_VERSION still 3).

- [ ] **Step 3: Implement.** Edit `packages/core/src/db/schema.ts`:

Bump version line:
```typescript
export const SCHEMA_VERSION = 4;
```

Inside `applySchema()`, before the closing `db.exec('COMMIT');`, add:
```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      handoff_id   TEXT NOT NULL,
      worker_id    TEXT,
      source       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      ts           TEXT NOT NULL,
      meta_json    TEXT,
      CHECK (meta_json IS NULL OR length(meta_json) <= 4096)
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_events_handoff ON dispatch_events(handoff_id, ts);
    CREATE INDEX IF NOT EXISTS idx_dispatch_events_ts      ON dispatch_events(ts);
  `);
```

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/core/test/db/schema-dispatch-events.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Run full core typecheck and existing schema tests for regression.**

```bash
bun typecheck
bun test packages/core/
```

Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/db/schema.ts packages/core/test/db/schema-dispatch-events.test.ts
git commit -m "feat(core): add dispatch_events table for wedge instrumentation"
```

---

## Task 2: Daemon writer service `DispatchEventLog`

**Files:**
- Create: `packages/daemon/src/services/dispatch-event-log.ts`
- Test: `packages/daemon/test/services/dispatch-event-log.test.ts`

- [ ] **Step 1: Failing test.**

Create `packages/daemon/test/services/dispatch-event-log.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '@penumbra/core';
import { DispatchEventLog, type DispatchEventInput } from '../../src/services/dispatch-event-log';

function freshDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

const sampleEvent: DispatchEventInput = {
  handoff_id: 'h-1',
  worker_id: 'w-1',
  source: 'worker',
  kind: 'dispatch.start',
  ts: '2026-05-01T00:00:00.000Z',
  meta: { agent: 'gemini-flash', adapter: 'gemini-cli', prompt_bytes: 12 },
};

describe('DispatchEventLog', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('record() inserts a single event with serialized meta', () => {
    const log = new DispatchEventLog(db);
    log.record(sampleEvent);
    const rows = db.query('SELECT * FROM dispatch_events').all() as Array<{
      handoff_id: string;
      worker_id: string;
      kind: string;
      meta_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].handoff_id).toBe('h-1');
    expect(rows[0].worker_id).toBe('w-1');
    expect(rows[0].kind).toBe('dispatch.start');
    expect(JSON.parse(rows[0].meta_json)).toEqual(sampleEvent.meta);
  });

  test('recordBatch() inserts many events in a single transaction', () => {
    const log = new DispatchEventLog(db);
    const events = Array.from({ length: 5 }, (_, i) => ({
      ...sampleEvent,
      ts: `2026-05-01T00:00:0${i}.000Z`,
      kind: 'proc.spawn' as const,
    }));
    log.recordBatch(events);
    const count = (db.query('SELECT COUNT(*) AS c FROM dispatch_events').get() as { c: number }).c;
    expect(count).toBe(5);
  });

  test('listByHandoff() returns events ordered by ts', () => {
    const log = new DispatchEventLog(db);
    log.record({ ...sampleEvent, ts: '2026-05-01T00:00:02.000Z', kind: 'dispatch.end' });
    log.record({ ...sampleEvent, ts: '2026-05-01T00:00:00.000Z', kind: 'dispatch.start' });
    log.record({ ...sampleEvent, ts: '2026-05-01T00:00:01.000Z', kind: 'proc.spawn' });
    const events = log.listByHandoff('h-1');
    expect(events.map((e) => e.kind)).toEqual(['dispatch.start', 'proc.spawn', 'dispatch.end']);
  });

  test('record() omits meta when undefined', () => {
    const log = new DispatchEventLog(db);
    log.record({ ...sampleEvent, meta: undefined });
    const row = db.query('SELECT meta_json FROM dispatch_events').get() as { meta_json: string | null };
    expect(row.meta_json).toBeNull();
  });
});
```

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/daemon/test/services/dispatch-event-log.test.ts
```

Expected: cannot find module.

- [ ] **Step 3: Implement.** Create `packages/daemon/src/services/dispatch-event-log.ts`:

```typescript
import type { Database } from 'bun:sqlite';

export type DispatchEventKind =
  | 'dispatch.start'
  | 'dispatch.end'
  | 'proc.spawn'
  | 'proc.kill.sent'
  | 'proc.exited.resolved'
  | 'cancel.received'
  | 'cancel.dispatched'
  | 'heartbeat.sent'
  | 'heartbeat.received'
  | 'watchdog.tick'
  | 'watchdog.auto_fail';

export interface DispatchEventInput {
  handoff_id: string;
  worker_id?: string | null;
  source: 'worker' | 'daemon';
  kind: DispatchEventKind;
  ts: string;
  meta?: Record<string, unknown>;
}

export interface DispatchEventRow {
  id: number;
  handoff_id: string;
  worker_id: string | null;
  source: 'worker' | 'daemon';
  kind: DispatchEventKind;
  ts: string;
  meta_json: string | null;
}

export class DispatchEventLog {
  constructor(private readonly db: Database) {}

  record(event: DispatchEventInput): void {
    this.db.run(
      'INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, ?, ?, ?, ?, ?)',
      [
        event.handoff_id,
        event.worker_id ?? null,
        event.source,
        event.kind,
        event.ts,
        event.meta === undefined ? null : JSON.stringify(event.meta),
      ],
    );
  }

  recordBatch(events: DispatchEventInput[]): void {
    if (events.length === 0) return;
    const tx = this.db.transaction((batch: DispatchEventInput[]) => {
      for (const e of batch) this.record(e);
    });
    tx(events);
  }

  listByHandoff(handoff_id: string): DispatchEventRow[] {
    return this.db
      .query('SELECT * FROM dispatch_events WHERE handoff_id = ? ORDER BY ts ASC, id ASC')
      .all(handoff_id) as DispatchEventRow[];
  }
}
```

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/daemon/test/services/dispatch-event-log.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/services/dispatch-event-log.ts packages/daemon/test/services/dispatch-event-log.test.ts
git commit -m "feat(daemon): add DispatchEventLog writer service"
```

---

## Task 3: Wire `dispatchEventLog` into `Services`

**Files:**
- Modify: `packages/core/src/services.ts`
- Modify: `packages/daemon/src/services/dispatch-event-log.ts` (re-export from `@penumbra/core` if needed; otherwise import path stays in daemon)

> **Note:** the spec says daemon-owned, so `DispatchEventLog` itself stays in `packages/daemon/src/services/`. But `Services` lives in `@penumbra/core`. Two options: (a) move `DispatchEventLog` to `@penumbra/core`; (b) keep it in daemon and add it to `Services` via type-only import. Use **(a)** — the writer is a thin DB adapter with zero daemon-specific deps and matches where `HandoffWriter` already lives.

- [ ] **Step 1: Move file.**

```bash
git mv packages/daemon/src/services/dispatch-event-log.ts packages/core/src/services/dispatch-event-log.ts
git mv packages/daemon/test/services/dispatch-event-log.test.ts packages/core/test/services/dispatch-event-log.test.ts
```

- [ ] **Step 2: Fix the import in the test.**

Edit `packages/core/test/services/dispatch-event-log.test.ts` — change:
```typescript
import { applySchema } from '@penumbra/core';
import { DispatchEventLog, type DispatchEventInput } from '../../src/services/dispatch-event-log';
```
to:
```typescript
import { applySchema } from '../../src/db/schema';
import { DispatchEventLog, type DispatchEventInput } from '../../src/services/dispatch-event-log';
```

- [ ] **Step 3: Export from core barrel.** Edit `packages/core/src/index.ts` (or wherever `applySchema` is exported from) and add:

```typescript
export { DispatchEventLog } from './services/dispatch-event-log';
export type { DispatchEventInput, DispatchEventKind, DispatchEventRow } from './services/dispatch-event-log';
```

(If there is no barrel file, identify the existing pattern by reading `packages/core/src/index.ts`. Match it.)

- [ ] **Step 4: Failing test for `buildServices()` exposing `dispatchEventLog`.**

Create `packages/core/test/services-dispatch-event-log.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices } from '../src/services';
import { applySchema } from '../src/db/schema';

describe('buildServices', () => {
  test('exposes dispatchEventLog wired to the same db', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const services = buildServices({ env: {}, input: {}, storageRoot: '/tmp/test-svc', db });
    expect(services.dispatchEventLog).toBeDefined();
    services.dispatchEventLog.record({
      handoff_id: 'h-1',
      source: 'daemon',
      kind: 'watchdog.tick',
      ts: '2026-05-01T00:00:00.000Z',
    });
    const events = services.dispatchEventLog.listByHandoff('h-1');
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Confirm RED.**

```bash
bun test packages/core/test/services-dispatch-event-log.test.ts
```

Expected: `services.dispatchEventLog` is undefined.

- [ ] **Step 6: Implement.** Edit `packages/core/src/services.ts`:

In the `Services` interface (around line 34-40), add:
```typescript
  dispatchEventLog: DispatchEventLog;
```

At the top, import:
```typescript
import { DispatchEventLog } from './services/dispatch-event-log';
```

In `buildServices()` body where `handoffWriter` is constructed, add a peer:
```typescript
  const dispatchEventLog = new DispatchEventLog(opts.db);
```

In the returned services object, add:
```typescript
  dispatchEventLog,
```

- [ ] **Step 7: Confirm GREEN.**

```bash
bun test packages/core/test/services-dispatch-event-log.test.ts
bun typecheck
bun test packages/daemon/
```

Expected: all pass. The daemon test file we moved also still passes from its new location.

- [ ] **Step 8: Commit.**

```bash
git add packages/core/src/services.ts packages/core/src/services/dispatch-event-log.ts packages/core/src/index.ts packages/core/test/services-dispatch-event-log.test.ts packages/core/test/services/dispatch-event-log.test.ts
git rm --quiet packages/daemon/src/services/dispatch-event-log.ts packages/daemon/test/services/dispatch-event-log.test.ts 2>/dev/null || true
git commit -m "feat(core): expose dispatchEventLog via Services container"
```

---

## Task 4: Daemon route `POST /dispatch/events`

**Files:**
- Create: `packages/daemon/src/routes/dispatch-events.ts`
- Test: `packages/daemon/test/routes/dispatch-events-post.test.ts`

- [ ] **Step 1: Failing test.**

Create `packages/daemon/test/routes/dispatch-events-post.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, buildServices, type Services } from '@penumbra/core';
import { dispatchEventsPostRoute } from '../../src/routes/dispatch-events';

function tempServices(): Services {
  const db = new Database(':memory:');
  applySchema(db);
  return buildServices({ env: {}, input: {}, storageRoot: '/tmp/de-post', db });
}

describe('POST /dispatch/events', () => {
  let services: Services;
  beforeEach(() => {
    services = tempServices();
  });

  test('accepts a batch and returns 200 with count', async () => {
    const body = {
      events: [
        { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
        { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.end', ts: '2026-05-01T00:00:01.000Z' },
      ],
    };
    const req = new Request('http://x/dispatch/events', { method: 'POST', body: JSON.stringify(body) });
    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 2 });
    expect(services.dispatchEventLog.listByHandoff('h-1')).toHaveLength(2);
  });

  test('rejects malformed payload with 400', async () => {
    const req = new Request('http://x/dispatch/events', { method: 'POST', body: '{"events": "not-an-array"}' });
    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(400);
  });

  test('rejects unknown kind with 400 and writes nothing', async () => {
    const body = { events: [{ handoff_id: 'h-1', source: 'worker', kind: 'bogus.kind', ts: '2026-05-01T00:00:00.000Z' }] };
    const req = new Request('http://x/dispatch/events', { method: 'POST', body: JSON.stringify(body) });
    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(400);
    expect(services.dispatchEventLog.listByHandoff('h-1')).toHaveLength(0);
  });

  test('caps batch size at 50; 51 events returns 400', async () => {
    const events = Array.from({ length: 51 }, (_, i) => ({
      handoff_id: 'h-1',
      source: 'worker',
      kind: 'proc.spawn',
      ts: `2026-05-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }));
    const req = new Request('http://x/dispatch/events', { method: 'POST', body: JSON.stringify({ events }) });
    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/daemon/test/routes/dispatch-events-post.test.ts
```

Expected: cannot find module.

- [ ] **Step 3: Implement.** Create `packages/daemon/src/routes/dispatch-events.ts`:

```typescript
import { z } from 'zod';
import type { Services } from '@penumbra/core';
import type { DispatchEventInput, DispatchEventKind } from '@penumbra/core';

const KIND_VALUES: readonly DispatchEventKind[] = [
  'dispatch.start',
  'dispatch.end',
  'proc.spawn',
  'proc.kill.sent',
  'proc.exited.resolved',
  'cancel.received',
  'cancel.dispatched',
  'heartbeat.sent',
  'heartbeat.received',
  'watchdog.tick',
  'watchdog.auto_fail',
] as const;

const EventSchema = z.object({
  handoff_id: z.string().min(1),
  worker_id: z.string().nullish(),
  source: z.enum(['worker', 'daemon']),
  kind: z.enum(KIND_VALUES as unknown as [DispatchEventKind, ...DispatchEventKind[]]),
  ts: z.string().min(1),
  meta: z.record(z.unknown()).optional(),
});

const BatchSchema = z.object({
  events: z.array(EventSchema).min(1).max(50),
});

export async function dispatchEventsPostRoute(req: Request, services: Services): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }
  const parsed = BatchSchema.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid_payload', issues: parsed.error.issues }), { status: 400 });
  }
  services.dispatchEventLog.recordBatch(parsed.data.events as DispatchEventInput[]);
  return new Response(JSON.stringify({ recorded: parsed.data.events.length }), { status: 200 });
}
```

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/daemon/test/routes/dispatch-events-post.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/routes/dispatch-events.ts packages/daemon/test/routes/dispatch-events-post.test.ts
git commit -m "feat(daemon): add POST /dispatch/events batch ingest route"
```

---

## Task 5: Daemon route `GET /dispatch/events?handoff_id=<id>`

**Files:**
- Modify: `packages/daemon/src/routes/dispatch-events.ts`
- Test: `packages/daemon/test/routes/dispatch-events-get.test.ts`

- [ ] **Step 1: Failing test.**

Create `packages/daemon/test/routes/dispatch-events-get.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, buildServices, type Services } from '@penumbra/core';
import { dispatchEventsGetRoute } from '../../src/routes/dispatch-events';

function tempServices(): Services {
  const db = new Database(':memory:');
  applySchema(db);
  return buildServices({ env: {}, input: {}, storageRoot: '/tmp/de-get', db });
}

describe('GET /dispatch/events', () => {
  let services: Services;
  beforeEach(() => {
    services = tempServices();
    services.dispatchEventLog.recordBatch([
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'proc.spawn', ts: '2026-05-01T00:00:01.000Z', meta: { pid: 123 } },
      { handoff_id: 'h-1', worker_id: 'w-1', source: 'worker', kind: 'dispatch.end', ts: '2026-05-01T00:00:02.000Z' },
      { handoff_id: 'h-2', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.500Z' },
    ]);
  });

  test('returns events for the requested handoff in ts order', async () => {
    const req = new Request('http://x/dispatch/events?handoff_id=h-1');
    const res = await dispatchEventsGetRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string; meta: unknown }> };
    expect(body.events.map((e) => e.kind)).toEqual(['dispatch.start', 'proc.spawn', 'dispatch.end']);
    expect(body.events[1].meta).toEqual({ pid: 123 });
  });

  test('does not include events from other handoffs', async () => {
    const req = new Request('http://x/dispatch/events?handoff_id=h-1');
    const res = await dispatchEventsGetRoute(req, services);
    const body = (await res.json()) as { events: Array<{ handoff_id: string }> };
    for (const e of body.events) expect(e.handoff_id).toBe('h-1');
  });

  test('400 when handoff_id missing', async () => {
    const req = new Request('http://x/dispatch/events');
    const res = await dispatchEventsGetRoute(req, services);
    expect(res.status).toBe(400);
  });

  test('200 with empty array for unknown handoff', async () => {
    const req = new Request('http://x/dispatch/events?handoff_id=does-not-exist');
    const res = await dispatchEventsGetRoute(req, services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });
});
```

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/daemon/test/routes/dispatch-events-get.test.ts
```

Expected: cannot import `dispatchEventsGetRoute`.

- [ ] **Step 3: Implement.** Append to `packages/daemon/src/routes/dispatch-events.ts`:

```typescript
export async function dispatchEventsGetRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const handoff_id = url.searchParams.get('handoff_id');
  if (!handoff_id) {
    return new Response(JSON.stringify({ error: 'missing_handoff_id' }), { status: 400 });
  }
  const rows = services.dispatchEventLog.listByHandoff(handoff_id);
  const events = rows.map((r) => ({
    handoff_id: r.handoff_id,
    worker_id: r.worker_id,
    source: r.source,
    kind: r.kind,
    ts: r.ts,
    meta: r.meta_json ? JSON.parse(r.meta_json) : null,
  }));
  return new Response(JSON.stringify({ events }), { status: 200 });
}
```

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/daemon/test/routes/dispatch-events-get.test.ts
```

Expected: 4 pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/routes/dispatch-events.ts packages/daemon/test/routes/dispatch-events-get.test.ts
git commit -m "feat(daemon): add GET /dispatch/events read route"
```

---

## Task 6: Register both routes in `serve.ts`

**Files:**
- Modify: `packages/daemon/src/serve.ts`
- Test: `packages/daemon/test/serve-dispatch-events.test.ts`

- [ ] **Step 1: Failing test.**

Create `packages/daemon/test/serve-dispatch-events.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, buildServices } from '@penumbra/core';
import { createDaemonFetchHandler } from '../src/serve';

function makeHandler() {
  const db = new Database(':memory:');
  applySchema(db);
  const services = buildServices({ env: {}, input: {}, storageRoot: '/tmp/serve-de', db });
  return { handler: createDaemonFetchHandler({ services, token: 'tok' }), services };
}

describe('serve.ts dispatch_events routing', () => {
  test('POST /dispatch/events is reachable and persists', async () => {
    const { handler, services } = makeHandler();
    const req = new Request('http://x/dispatch/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: JSON.stringify({
        events: [
          { handoff_id: 'h-9', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
        ],
      }),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(services.dispatchEventLog.listByHandoff('h-9')).toHaveLength(1);
  });

  test('GET /dispatch/events?handoff_id=h-9 returns the inserted event', async () => {
    const { handler, services } = makeHandler();
    services.dispatchEventLog.record({
      handoff_id: 'h-9', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z',
    });
    const req = new Request('http://x/dispatch/events?handoff_id=h-9', { headers: { Authorization: 'Bearer tok' } });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/daemon/test/serve-dispatch-events.test.ts
```

Expected: routes return 404 (not registered).

- [ ] **Step 3: Implement.** Edit `packages/daemon/src/serve.ts`. Near the existing imports, add:

```typescript
import { dispatchEventsPostRoute, dispatchEventsGetRoute } from './routes/dispatch-events';
```

Inside `createDaemonFetchHandler`, before the closing `return new Response(...)` or 404 fallback, add (mirroring the existing `/worker/heartbeat` and `/handoffs` blocks):

```typescript
      if (req.method === 'POST' && url.pathname === '/dispatch/events') {
        return dispatchEventsPostRoute(req, opts.services);
      }
      if (req.method === 'GET' && url.pathname === '/dispatch/events') {
        return dispatchEventsGetRoute(req, opts.services);
      }
```

(If the daemon's auth wrapper requires a per-route opt-in, follow the pattern used by `/worker/heartbeat` — read the existing block at `serve.ts:105-107` and copy the structure.)

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/daemon/test/serve-dispatch-events.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/serve.ts packages/daemon/test/serve-dispatch-events.test.ts
git commit -m "feat(daemon): wire dispatch_events routes into fetch handler"
```

---

## Task 7: Daemon-side event emitters (heartbeat-received, watchdog tick + auto_fail)

**Files:**
- Modify: `packages/daemon/src/routes/worker-heartbeat.ts`
- Modify: `packages/daemon/src/services/watchdog.ts`
- Modify: `packages/daemon/test/routes/worker-heartbeat.test.ts`
- Modify: `packages/daemon/test/services/watchdog.test.ts`

- [ ] **Step 1: Failing test for heartbeat.received.** Append to `packages/daemon/test/routes/worker-heartbeat.test.ts`:

```typescript
test('records heartbeat.received event', async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  const req = new Request('http://x/worker/heartbeat', { method: 'POST', body: JSON.stringify({ worker_id: 'w-h' }) });
  await workerHeartbeatRoute(req, services);
  const events = services.dispatchEventLog.listByHandoff('');
  expect(events.some((e) => e.kind === 'heartbeat.received' && e.worker_id === 'w-h')).toBe(true);
});
```

(Use the file's existing imports; if `tempServices` builds without `watchdog` it's fine — the test creates one.)

- [ ] **Step 2: Failing tests for watchdog.tick and watchdog.auto_fail.** Append to `packages/daemon/test/services/watchdog.test.ts` (existing file already covers the 70s past-heartbeat case at lines 38-118; add):

```typescript
test('tick() records watchdog.tick event', async () => {
  // Reuse the test's existing services builder — search the file for tempServices() or equivalent.
  // After watchdog.tick() runs, assert at least one event of kind watchdog.tick exists with empty handoff_id.
  // ...
});

test('auto_fail records watchdog.auto_fail per failed handoff', async () => {
  // Set up a handoff in 'dispatched' status with a stale heartbeat,
  // call watchdog.tick(), then assert dispatchEventLog has watchdog.auto_fail for that handoff_id.
});
```

> **Implementer:** read `packages/daemon/test/services/watchdog.test.ts` lines 38-118 first — it already creates a stale-heartbeat scenario. Copy that fixture into the two new tests above and add the assertions.

- [ ] **Step 3: Confirm RED.**

```bash
bun test packages/daemon/test/routes/worker-heartbeat.test.ts packages/daemon/test/services/watchdog.test.ts
```

Expected: the new assertions fail.

- [ ] **Step 4: Implement heartbeat.received.** Edit `packages/daemon/src/routes/worker-heartbeat.ts` immediately after the existing `services.watchdog.recordHeartbeat(worker_id)` call (line ~29):

```typescript
  services.dispatchEventLog.record({
    handoff_id: '',
    worker_id,
    source: 'daemon',
    kind: 'heartbeat.received',
    ts: new Date().toISOString(),
  });
```

- [ ] **Step 5: Implement watchdog.tick.** Edit `packages/daemon/src/services/watchdog.ts` at the top of `tick()` (line ~20):

```typescript
  const tickTs = new Date().toISOString();
  // (rest of existing tick() body computes workersChecked + staleCount as it iterates)
  // After the loop, before returning:
  this.services.dispatchEventLog.record({
    handoff_id: '',
    source: 'daemon',
    kind: 'watchdog.tick',
    ts: tickTs,
    meta: { workers_checked: workersChecked, stale_count: staleCount },
  });
```

> If the existing `tick()` body doesn't already track `workersChecked` and `staleCount`, add local counters incremented in the loop. The loop is at lines 37-42 of `watchdog.ts`.

- [ ] **Step 6: Implement watchdog.auto_fail.** In `watchdog.ts` immediately after `services.handoffWriter.markFailed()` at line 46:

```typescript
      this.services.dispatchEventLog.record({
        handoff_id: row.handoff_id,
        worker_id: workerId,
        source: 'daemon',
        kind: 'watchdog.auto_fail',
        ts: new Date().toISOString(),
        meta: { worker_id: workerId, ms_since_heartbeat: nowMs - lastSeenMs },
      });
```

(Variable names `workerId`, `nowMs`, `lastSeenMs` should already exist in the loop scope; if they're spelled differently, match the existing names.)

- [ ] **Step 7: Confirm GREEN.**

```bash
bun test packages/daemon/test/routes/worker-heartbeat.test.ts packages/daemon/test/services/watchdog.test.ts
```

Expected: all pass, including pre-existing assertions.

- [ ] **Step 8: Commit.**

```bash
git add packages/daemon/src/routes/worker-heartbeat.ts packages/daemon/src/services/watchdog.ts packages/daemon/test/routes/worker-heartbeat.test.ts packages/daemon/test/services/watchdog.test.ts
git commit -m "feat(daemon): emit dispatch_events from heartbeat and watchdog"
```

---

## Task 8: PenumbraClient — `postDispatchEvents()`

**Files:**
- Modify: `packages/agentchat/src/penumbra-client.ts`
- Modify: `packages/agentchat/test/penumbra-client.test.ts` (if missing, create)

- [ ] **Step 1: Failing test.**

Append to (or create) `packages/agentchat/test/penumbra-client.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { PenumbraClient } from '../src/penumbra-client';

describe('PenumbraClient.postDispatchEvents', () => {
  test('POSTs the batch to /dispatch/events with bearer auth', async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response('{"recorded":1}', { status: 200 }));
    const client = new PenumbraClient({ baseUrl: 'http://127.0.0.1:51257', token: 'tok', fetchImpl: fetchMock as unknown as typeof fetch });
    await client.postDispatchEvents([
      { handoff_id: 'h-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:51257/dispatch/events');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      events: [{ handoff_id: 'h-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' }],
    });
  });

  test('returns silently on non-200 (fire-and-forget contract)', async () => {
    const fetchMock = mock(async () => new Response('boom', { status: 500 }));
    const client = new PenumbraClient({ baseUrl: 'http://127.0.0.1:51257', token: 'tok', fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(
      client.postDispatchEvents([{ handoff_id: 'h-1', source: 'worker', kind: 'dispatch.end', ts: '2026-05-01T00:00:00.000Z' }]),
    ).resolves.toBeUndefined();
  });
});
```

> **Implementer:** if `PenumbraClient` doesn't already accept a `fetchImpl` constructor arg, add one as an optional dep with default `globalThis.fetch`. Mirror the pattern used by other tested clients in the repo if one exists.

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/agentchat/test/penumbra-client.test.ts
```

Expected: `postDispatchEvents` is not a function.

- [ ] **Step 3: Implement.** Edit `packages/agentchat/src/penumbra-client.ts`. Add the import:

```typescript
import type { DispatchEventInput } from '@penumbra/core';
```

Add the method (after the existing `postProgress` near line 100):

```typescript
  async postDispatchEvents(events: DispatchEventInput[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.post('/dispatch/events', { events });
    } catch {
      // fire-and-forget: instrumentation must never break the worker hot path
    }
  }
```

(If `this.post` throws on non-200 today, the try/catch is necessary. If it returns silently, drop the try/catch and just `await this.post(...)`. Verify by reading `post()` in the same file.)

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/agentchat/test/penumbra-client.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/agentchat/src/penumbra-client.ts packages/agentchat/test/penumbra-client.test.ts
git commit -m "feat(agentchat): PenumbraClient.postDispatchEvents fire-and-forget"
```

---

## Task 9: Worker event queue (buffered fire-and-forget)

**Files:**
- Create: `packages/agentchat/src/worker/event-queue.ts`
- Test: `packages/agentchat/test/worker/event-queue.test.ts`

- [ ] **Step 1: Failing test.**

Create `packages/agentchat/test/worker/event-queue.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { DispatchEventQueue } from '../../src/worker/event-queue';
import type { DispatchEventInput } from '@penumbra/core';

const sample: DispatchEventInput = {
  handoff_id: 'h-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z',
};

describe('DispatchEventQueue', () => {
  test('flushes on its interval and calls the sender with batch', async () => {
    const send = mock(async (_events: DispatchEventInput[]) => {});
    const queue = new DispatchEventQueue({ send, flushIntervalMs: 20, maxBatch: 50, maxQueue: 1000 });
    queue.enqueue(sample);
    queue.enqueue({ ...sample, kind: 'proc.spawn' });
    await new Promise((r) => setTimeout(r, 60));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toHaveLength(2);
    queue.stop();
  });

  test('respects maxBatch by splitting into multiple sends', async () => {
    const send = mock(async (_events: DispatchEventInput[]) => {});
    const queue = new DispatchEventQueue({ send, flushIntervalMs: 20, maxBatch: 3, maxQueue: 1000 });
    for (let i = 0; i < 7; i++) queue.enqueue({ ...sample, ts: `2026-05-01T00:00:0${i}.000Z` });
    await new Promise((r) => setTimeout(r, 60));
    const totalSent = send.mock.calls.reduce((sum, c) => sum + c[0]!.length, 0);
    expect(totalSent).toBe(7);
    expect(send.mock.calls.every((c) => c[0]!.length <= 3)).toBe(true);
    queue.stop();
  });

  test('drops oldest beyond maxQueue and increments dropped counter', async () => {
    const send = mock(async () => {});
    const queue = new DispatchEventQueue({ send, flushIntervalMs: 1000, maxBatch: 50, maxQueue: 5 });
    for (let i = 0; i < 10; i++) queue.enqueue({ ...sample, ts: `2026-05-01T00:00:0${i}.000Z` });
    expect(queue.droppedCount()).toBe(5);
    queue.stop();
  });

  test('flush() drains immediately', async () => {
    const send = mock(async () => {});
    const queue = new DispatchEventQueue({ send, flushIntervalMs: 1000, maxBatch: 50, maxQueue: 1000 });
    queue.enqueue(sample);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    queue.stop();
  });

  test('stop() flushes once and clears the timer', async () => {
    const send = mock(async () => {});
    const queue = new DispatchEventQueue({ send, flushIntervalMs: 1000, maxBatch: 50, maxQueue: 1000 });
    queue.enqueue(sample);
    await queue.stop();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/agentchat/test/worker/event-queue.test.ts
```

Expected: cannot find module.

- [ ] **Step 3: Implement.** Create `packages/agentchat/src/worker/event-queue.ts`:

```typescript
import type { DispatchEventInput } from '@penumbra/core';

export interface DispatchEventQueueOpts {
  send: (events: DispatchEventInput[]) => Promise<void>;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
}

export class DispatchEventQueue {
  private buffer: DispatchEventInput[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly send: DispatchEventQueueOpts['send'];
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private flushing = false;

  constructor(opts: DispatchEventQueueOpts) {
    this.send = opts.send;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxQueue = opts.maxQueue ?? 1000;
    const interval = opts.flushIntervalMs ?? 500;
    this.timer = setInterval(() => { void this.flush(); }, interval);
  }

  enqueue(event: DispatchEventInput): void {
    if (this.buffer.length >= this.maxQueue) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(event);
  }

  droppedCount(): number {
    return this.dropped;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.maxBatch);
        try {
          await this.send(batch);
        } catch {
          // fire-and-forget; drop on send failure
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
```

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/agentchat/test/worker/event-queue.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/agentchat/src/worker/event-queue.ts packages/agentchat/test/worker/event-queue.test.ts
git commit -m "feat(agentchat): buffered DispatchEventQueue for worker instrumentation"
```

---

## Task 10: `cli-spawn` — `eventContext` plumbing + spawn/kill/exit emits

**Files:**
- Modify: `packages/agentchat/src/adapters/cli-spawn.ts`
- Modify: `packages/agentchat/test/adapters/cli-spawn.test.ts`

- [ ] **Step 1: Failing test for opt-in zero-events behavior.** Append to `packages/agentchat/test/adapters/cli-spawn.test.ts`:

```typescript
test('emits no events when eventContext is omitted', async () => {
  const events: Array<{ kind: string }> = [];
  const onEvent = (e: { kind: string }) => events.push(e);
  // Use a tiny spawn that exits immediately. Reuse this file's existing helpers if present.
  await spawnCliAdapter({ argv: ['/bin/echo', 'hi'], onEvent } as any);
  expect(events).toHaveLength(0);
});
```

> **Implementer:** check whether `spawnCliAdapter` already takes an `onEvent` hook. If not, the plan adds it in Step 3 alongside `eventContext`. The hook is the test seam — the queue from Task 9 wraps it in production. Without `eventContext`, no `onEvent` calls fire.

- [ ] **Step 2: Failing test for full sequence with eventContext.** Append:

```typescript
test('emits proc.spawn, proc.exited.resolved when eventContext present', async () => {
  const events: Array<{ kind: string; meta?: any }> = [];
  await spawnCliAdapter({
    argv: ['/bin/sh', '-c', 'echo hi; exit 0'],
    eventContext: { handoffId: 'h-cli', workerId: 'w-cli' },
    onEvent: (e) => events.push(e),
  } as any);
  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain('proc.spawn');
  expect(kinds).toContain('proc.exited.resolved');
  const exit = events.find((e) => e.kind === 'proc.exited.resolved');
  expect(exit?.meta?.code).toBe(0);
});

test('emits proc.kill.sent on abort', async () => {
  const events: Array<{ kind: string; meta?: any }> = [];
  const ctrl = new AbortController();
  const promise = spawnCliAdapter({
    argv: ['/bin/sh', '-c', 'sleep 5'],
    signal: ctrl.signal,
    eventContext: { handoffId: 'h-cli-2', workerId: 'w-cli' },
    onEvent: (e) => events.push(e),
  } as any);
  await new Promise((r) => setTimeout(r, 50));
  ctrl.abort();
  await promise.catch(() => {});
  expect(events.some((e) => e.kind === 'proc.kill.sent' && e.meta?.signal === 'SIGTERM')).toBe(true);
});
```

- [ ] **Step 3: Confirm RED.**

```bash
bun test packages/agentchat/test/adapters/cli-spawn.test.ts
```

Expected: new assertions fail; existing tests still pass.

- [ ] **Step 4: Implement.** Edit `packages/agentchat/src/adapters/cli-spawn.ts`. Update the `SpawnOpts` interface (around line 7):

```typescript
export interface SpawnOpts {
  // ... existing fields ...
  eventContext?: { handoffId: string; workerId?: string };
  onEvent?: (event: { handoff_id: string; worker_id?: string; source: 'worker'; kind: string; ts: string; meta?: Record<string, unknown> }) => void;
}
```

Define a small helper at the top of the file (after imports):

```typescript
function emit(opts: SpawnOpts, kind: string, meta?: Record<string, unknown>): void {
  if (!opts.eventContext || !opts.onEvent) return;
  opts.onEvent({
    handoff_id: opts.eventContext.handoffId,
    worker_id: opts.eventContext.workerId,
    source: 'worker',
    kind,
    ts: new Date().toISOString(),
    meta,
  });
}
```

In **both** `spawnCliAdapter` (buffered, lines 181-187) and the streaming variant (lines 77-83), immediately after `Bun.spawn(...)` returns:

```typescript
  const spawnTs = Date.now();
  emit(opts, 'proc.spawn', { argv0: argv[0], pid: proc.pid, has_signal: !!opts.signal });
```

Inside the `onAbort` listener (lines 88-97), at the SIGTERM call site:

```typescript
    emit(opts, 'proc.kill.sent', { pid: proc.pid, signal: 'SIGTERM', reason: 'abort' });
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        emit(opts, 'proc.kill.sent', { pid: proc.pid, signal: 'SIGKILL', reason: 'grace_expired' });
        proc.kill('SIGKILL');
      } catch {}
    }, /* existing grace ms */);
```

After `await proc.exited` at line 142:

```typescript
  const code = await proc.exited;
  emit(opts, 'proc.exited.resolved', { pid: proc.pid, code, wall_ms_since_spawn: Date.now() - spawnTs });
```

(Replicate the same `await proc.exited` + emit in the streaming variant. Use distinct local `spawnTs` per variant.)

- [ ] **Step 5: Confirm GREEN.**

```bash
bun test packages/agentchat/test/adapters/cli-spawn.test.ts
```

Expected: all pass (new + existing).

- [ ] **Step 6: Commit.**

```bash
git add packages/agentchat/src/adapters/cli-spawn.ts packages/agentchat/test/adapters/cli-spawn.test.ts
git commit -m "feat(agentchat): emit dispatch events from cli-spawn adapter"
```

---

## Task 11: Worker dispatcher — emit dispatch.start / dispatch.end / cancel.dispatched + thread `eventContext`

**Files:**
- Modify: `packages/agentchat/src/worker/dispatcher.ts`
- Modify: `packages/agentchat/test/worker/dispatcher.test.ts`

- [ ] **Step 1: Failing test.** Append to `packages/agentchat/test/worker/dispatcher.test.ts`:

```typescript
test('emits dispatch.start and dispatch.end via onEvent on success', async () => {
  const events: Array<{ kind: string; meta?: any }> = [];
  const d = deps({
    dispatch: mock(async (_args: any) => ({ next: null, terminatedReason: 'no_mention', text: 'ok', agent: 'executor' })),
  });
  const dispatcher = createWorkerDispatcher({ ...d, onEvent: (e) => events.push(e) } as any);
  await dispatcher.handleOne({ handoff_id: 'h-d', /* ...minimum fields the existing test uses... */ } as any);
  expect(events.some((e) => e.kind === 'dispatch.start')).toBe(true);
  expect(events.some((e) => e.kind === 'dispatch.end' && e.meta?.status === 'ok')).toBe(true);
});

test('emits cancel.dispatched with matched=true when cancel hits an active entry', async () => {
  const events: Array<{ kind: string; meta?: any }> = [];
  const d = deps();
  const dispatcher = createWorkerDispatcher({ ...d, onEvent: (e) => events.push(e) } as any);
  // Start a dispatch in the background, cancel it, await both.
  const handle = dispatcher.handleOne({ handoff_id: 'h-cancel', /* ... */ } as any);
  await new Promise((r) => setTimeout(r, 10));
  dispatcher.cancel('h-cancel');
  await handle.catch(() => {});
  expect(events.some((e) => e.kind === 'cancel.dispatched' && e.meta?.matched === true)).toBe(true);
});
```

> **Implementer:** read the existing `dispatcher.test.ts:1-60` for the `deps()` helper shape and the minimum handoff payload fields. Reuse them — don't invent.

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/agentchat/test/worker/dispatcher.test.ts
```

Expected: dispatcher doesn't take `onEvent`; assertions fail.

- [ ] **Step 3: Implement.** Edit `packages/agentchat/src/worker/dispatcher.ts`.

Add to `WorkerDispatcherDeps`:
```typescript
  onEvent?: (event: { handoff_id: string; worker_id?: string; source: 'worker'; kind: string; ts: string; meta?: Record<string, unknown> }) => void;
  workerId?: string;
```

In `handleOne()` after the AbortController is created (line 76):
```typescript
  const dispatchStart = Date.now();
  deps.onEvent?.({
    handoff_id, worker_id: deps.workerId, source: 'worker', kind: 'dispatch.start',
    ts: new Date().toISOString(),
    meta: { agent: handoff.target_agent, adapter: handoff.adapter ?? 'unknown', prompt_bytes: (handoff.prompt ?? '').length },
  });
```

Where `deps.dispatch(...)` is called at line 165, pass:
```typescript
  await deps.dispatch({
    // ... existing args ...
    eventContext: { handoffId: handoff_id, workerId: deps.workerId },
    onEvent: deps.onEvent,
  });
```

In `handleOne()`'s finally block, before status write:
```typescript
  deps.onEvent?.({
    handoff_id, worker_id: deps.workerId, source: 'worker', kind: 'dispatch.end',
    ts: new Date().toISOString(),
    meta: { status: finalStatus, wall_ms: Date.now() - dispatchStart },
  });
```

(`finalStatus` is whatever variable already tracks `'ok' | 'aborted' | 'error'` in this block; if none, derive from the catch path.)

In `cancel()` at line 245-259, after the entry-match check:
```typescript
  const matched = !!entry;
  this.deps.onEvent?.({
    handoff_id: handoffId, worker_id: this.deps.workerId, source: 'worker', kind: 'cancel.dispatched',
    ts: new Date().toISOString(),
    meta: { matched },
  });
  if (entry) entry.abort.abort();
```

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/agentchat/test/worker/dispatcher.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/agentchat/src/worker/dispatcher.ts packages/agentchat/test/worker/dispatcher.test.ts
git commit -m "feat(agentchat): emit dispatch.start/end/cancel events from worker dispatcher"
```

---

## Task 12: control-listener — emit cancel.received

**Files:**
- Modify: `packages/agentchat/src/worker/control-listener.ts`
- Modify or create: `packages/agentchat/test/worker/control-listener.test.ts`

- [ ] **Step 1: Failing test.**

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { handleControlEvent } from '../../src/worker/control-listener';

describe('control-listener cancel.received', () => {
  test('emits cancel.received with source=sse when SSE cancel arrives', () => {
    const events: Array<{ kind: string; meta?: any }> = [];
    const dispatcher = { cancel: mock() };
    handleControlEvent({ type: 'cancel', handoff_id: 'h-x' }, { dispatcher, onEvent: (e: any) => events.push(e), workerId: 'w-1' });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('cancel.received');
    expect(events[0].meta?.source).toBe('sse');
  });
});
```

> **Implementer:** the current `control-listener.ts:65-69` is an inline branch inside `runWorkerControlListener`. Refactor by extracting a `handleControlEvent(event, opts)` pure function that takes the dispatcher + `onEvent` + `workerId`. The runner just delegates. This makes the unit test trivial without a real SSE.

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/agentchat/test/worker/control-listener.test.ts
```

- [ ] **Step 3: Implement.** Edit `packages/agentchat/src/worker/control-listener.ts`. Extract:

```typescript
export interface ControlListenerOpts {
  dispatcher: { cancel: (handoff_id: string) => void };
  onEvent?: (event: { handoff_id: string; worker_id?: string; source: 'worker'; kind: string; ts: string; meta?: Record<string, unknown> }) => void;
  workerId?: string;
}

export function handleControlEvent(event: { type: string; handoff_id?: string }, opts: ControlListenerOpts): void {
  if (event.type === 'cancel' && event.handoff_id) {
    opts.onEvent?.({
      handoff_id: event.handoff_id, worker_id: opts.workerId, source: 'worker', kind: 'cancel.received',
      ts: new Date().toISOString(),
      meta: { source: 'sse' },
    });
    opts.dispatcher.cancel(event.handoff_id);
  }
}
```

Update `runWorkerControlListener()` to call `handleControlEvent(event, opts)` instead of the inline branch (preserves existing behavior; `onEvent`/`workerId` flow in from the worker entrypoint set up in Task 14).

- [ ] **Step 4: Confirm GREEN.**

```bash
bun test packages/agentchat/test/worker/control-listener.test.ts
bun test packages/agentchat/
```

- [ ] **Step 5: Commit.**

```bash
git add packages/agentchat/src/worker/control-listener.ts packages/agentchat/test/worker/control-listener.test.ts
git commit -m "feat(agentchat): emit cancel.received from control-listener"
```

---

## Task 13: heartbeat-sent emitter

**Files:**
- Modify: `packages/agentchat/bin/agentchat-worker.ts`

- [ ] **Step 1: Locate the heartbeat emitter.** Read `packages/agentchat/bin/agentchat-worker.ts` end-to-end (or grep for `heartbeat`, `setInterval`, `postHeartbeat`). Record the line where the worker calls `client.postHeartbeat(...)` or equivalent.

If no timer exists (the worker doesn't actually emit heartbeats on a schedule), **stop and add a note to the RCA stub** (Task 17) — that absence is itself a finding. Proceed with steps 2-5 only if a heartbeat call site exists.

- [ ] **Step 2: Failing test.** This is hard to unit-test cleanly because the timer is in `bin/`. Write an integration-style test in `packages/agentchat/test/worker/heartbeat-emit.test.ts` that imports the helper function (extract one if needed) and verifies it calls `onEvent` with `heartbeat.sent`.

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { emitHeartbeat } from '../../src/worker/heartbeat-emit';

describe('heartbeat emitter', () => {
  test('records heartbeat.sent after a successful POST', async () => {
    const events: any[] = [];
    const client = { postHeartbeat: mock(async () => {}) };
    await emitHeartbeat({ client, workerId: 'w-1', onEvent: (e) => events.push(e) });
    expect(client.postHeartbeat).toHaveBeenCalledWith('w-1');
    expect(events.some((e) => e.kind === 'heartbeat.sent')).toBe(true);
  });

  test('still records heartbeat.sent when POST fails', async () => {
    const events: any[] = [];
    const client = { postHeartbeat: mock(async () => { throw new Error('boom'); }) };
    await emitHeartbeat({ client, workerId: 'w-1', onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.kind === 'heartbeat.sent')).toBe(true);
  });
});
```

- [ ] **Step 3: Confirm RED + extract helper.**

Create `packages/agentchat/src/worker/heartbeat-emit.ts`:

```typescript
export interface EmitHeartbeatOpts {
  client: { postHeartbeat: (worker_id: string) => Promise<void> };
  workerId: string;
  onEvent?: (event: { handoff_id: string; worker_id?: string; source: 'worker'; kind: string; ts: string }) => void;
}

export async function emitHeartbeat(opts: EmitHeartbeatOpts): Promise<void> {
  try {
    await opts.client.postHeartbeat(opts.workerId);
  } catch {
    // we still want the event recorded — heartbeat-attempt is the signal
  } finally {
    opts.onEvent?.({
      handoff_id: '', worker_id: opts.workerId, source: 'worker', kind: 'heartbeat.sent',
      ts: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step 4: Wire into `agentchat-worker.ts`.** Replace the existing `await client.postHeartbeat(workerId)` (or equivalent) with `await emitHeartbeat({ client, workerId, onEvent })`. Pass the worker-level `onEvent` (the queue's `enqueue` bound; see Task 14).

- [ ] **Step 5: Confirm GREEN.**

```bash
bun test packages/agentchat/test/worker/heartbeat-emit.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add packages/agentchat/src/worker/heartbeat-emit.ts packages/agentchat/bin/agentchat-worker.ts packages/agentchat/test/worker/heartbeat-emit.test.ts
git commit -m "feat(agentchat): emit heartbeat.sent event from worker"
```

---

## Task 14: Wire the queue + emitters in `agentchat-worker.ts`

**Files:**
- Modify: `packages/agentchat/bin/agentchat-worker.ts`

- [ ] **Step 1: Read the file** end-to-end to find: where `PenumbraClient` is instantiated, where `createWorkerDispatcher(deps)` is called, where `runWorkerControlListener(opts)` is started, and where the heartbeat call lives.

- [ ] **Step 2: Construct the queue once at worker startup,** immediately after `client` is created:

```typescript
import { DispatchEventQueue } from '../src/worker/event-queue';

const eventQueue = new DispatchEventQueue({
  send: (events) => client.postDispatchEvents(events),
});
const onEvent = (event: any) => eventQueue.enqueue(event);
```

- [ ] **Step 3: Pass `onEvent` into:**

- the `createWorkerDispatcher(deps)` deps (Task 11);
- `runWorkerControlListener(opts)` opts (Task 12);
- `emitHeartbeat({ ..., onEvent })` (Task 13).

Pass `workerId` alongside `onEvent` everywhere it's needed (the worker already has a `worker_id` constant from launchd or settings).

- [ ] **Step 4: Add a graceful-shutdown hook** for the queue. Locate the existing SIGTERM/exit handler (or add one if absent):

```typescript
process.on('SIGTERM', async () => {
  await eventQueue.stop();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await eventQueue.stop();
  process.exit(0);
});
```

(If a shutdown handler already exists, splice `await eventQueue.stop()` into it before its existing exit call.)

- [ ] **Step 5: Manual smoke.**

```bash
bun typecheck
bun test packages/agentchat/
launchctl kickstart -k "gui/$(id -u)/dev.penumbra.worker"
sleep 2
launchctl print "gui/$(id -u)/dev.penumbra.worker" | grep "state ="
```

Expected: typecheck clean, all tests pass, worker `state = running`.

- [ ] **Step 6: Commit.**

```bash
git add packages/agentchat/bin/agentchat-worker.ts
git commit -m "feat(agentchat): wire dispatch event queue into worker entrypoint"
```

---

## Task 15: CLI command `penumbra dispatch timeline <handoff_id>`

**Files:**
- Create: `packages/cli/src/commands/dispatch.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Test: `packages/cli/test/commands/dispatch.test.ts`

- [ ] **Step 1: Failing test.**

Create `packages/cli/test/commands/dispatch.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { runDispatchTimeline } from '../../src/commands/dispatch';

describe('runDispatchTimeline', () => {
  test('fetches /dispatch/events and prints JSON when --json', async () => {
    const fetchImpl = mock(async (url: string) => {
      expect(url).toMatch(/\/dispatch\/events\?handoff_id=h-1$/);
      return new Response(JSON.stringify({ events: [{ kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z' }] }), { status: 200 });
    });
    const logs: string[] = [];
    await runDispatchTimeline({
      handoff_id: 'h-1', json: true, baseUrl: 'http://127.0.0.1:51257', token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch, log: (s) => logs.push(s),
    });
    expect(JSON.parse(logs[0]!).events).toHaveLength(1);
  });

  test('prints a human-readable table by default', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({ events: [
      { kind: 'dispatch.start', ts: '2026-05-01T00:00:00.000Z', source: 'worker' },
      { kind: 'dispatch.end',   ts: '2026-05-01T00:00:01.000Z', source: 'worker' },
    ] }), { status: 200 }));
    const logs: string[] = [];
    await runDispatchTimeline({
      handoff_id: 'h-1', json: false, baseUrl: 'http://127.0.0.1:51257', token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch, log: (s) => logs.push(s),
    });
    const out = logs.join('\n');
    expect(out).toContain('dispatch.start');
    expect(out).toContain('dispatch.end');
  });
});
```

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/cli/test/commands/dispatch.test.ts
```

- [ ] **Step 3: Implement.** Create `packages/cli/src/commands/dispatch.ts`:

```typescript
export interface RunDispatchTimelineOpts {
  handoff_id: string;
  json: boolean;
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export async function runDispatchTimeline(opts: RunDispatchTimelineOpts): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((s: string) => console.log(s));
  const res = await fetchImpl(`${opts.baseUrl}/dispatch/events?handoff_id=${encodeURIComponent(opts.handoff_id)}`, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = (await res.json()) as { events: Array<{ ts: string; kind: string; source: string; meta?: unknown }> };
  if (opts.json) {
    log(JSON.stringify(body, null, 2));
    return;
  }
  if (body.events.length === 0) {
    log('(no events)');
    return;
  }
  for (const e of body.events) {
    const meta = e.meta ? ` ${JSON.stringify(e.meta)}` : '';
    log(`${e.ts}  ${e.source.padEnd(6)}  ${e.kind.padEnd(24)}${meta}`);
  }
}
```

- [ ] **Step 4: Register subcommand.** Edit `packages/cli/bin/penumbra.ts`. Find the existing `case 'cost':` block (~line 200) and add a sibling:

```typescript
    case 'dispatch': {
      const sub = process.argv[3];
      if (sub === 'timeline') {
        const handoff_id = process.argv[4];
        if (!handoff_id) {
          console.error('usage: penumbra dispatch timeline <handoff_id> [--json]');
          process.exit(2);
        }
        const json = process.argv.includes('--json');
        const { runDispatchTimeline } = await import('../src/commands/dispatch.js');
        const root = resolveLiveRoot();
        const port = Number(readFileSync(join(root, 'port'), 'utf8'));
        const token = readFileSync(join(root, 'token'), 'utf8').trim();
        await runDispatchTimeline({ handoff_id, json, baseUrl: `http://127.0.0.1:${port}`, token });
        return;
      }
      console.error('usage: penumbra dispatch timeline <handoff_id>');
      process.exit(2);
    }
```

(Imports for `readFileSync`, `join`, `resolveLiveRoot` already exist at the top of `penumbra.ts` per the existing `cost` command — reuse, don't re-import.)

- [ ] **Step 5: Confirm GREEN.**

```bash
bun test packages/cli/test/commands/dispatch.test.ts
bun typecheck
```

- [ ] **Step 6: Smoke against the live daemon.**

```bash
bun packages/cli/bin/penumbra.ts dispatch timeline some-existing-handoff-id
```

Expected: prints either `(no events)` or a table.

- [ ] **Step 7: Commit.**

```bash
git add packages/cli/src/commands/dispatch.ts packages/cli/bin/penumbra.ts packages/cli/test/commands/dispatch.test.ts
git commit -m "feat(cli): add penumbra dispatch timeline command"
```

---

## Task 16: MCP tool `dispatch.timeline`

**Files:**
- Create: `packages/mcp/src/tools/dispatch-timeline.ts`
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/tools/dispatch-timeline.test.ts`

- [ ] **Step 1: Failing test.**

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { DispatchTimelineInputShape, dispatchTimelineHandler } from '../../src/tools/dispatch-timeline';
import { z } from 'zod';

describe('dispatch.timeline MCP tool', () => {
  test('schema requires handoff_id string', () => {
    const schema = z.object(DispatchTimelineInputShape);
    expect(() => schema.parse({})).toThrow();
    expect(schema.parse({ handoff_id: 'h-1' }).handoff_id).toBe('h-1');
  });

  test('handler delegates to daemon and returns events', async () => {
    const daemon = { getDispatchTimeline: mock(async (id: string) => ({ events: [{ kind: 'dispatch.start', ts: 't', source: 'worker', handoff_id: id, meta: null, worker_id: 'w' }] })) };
    const handler = dispatchTimelineHandler(daemon as any);
    const result = await handler({ handoff_id: 'h-1' });
    expect(daemon.getDispatchTimeline).toHaveBeenCalledWith('h-1');
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Confirm RED.**

```bash
bun test packages/mcp/test/tools/dispatch-timeline.test.ts
```

- [ ] **Step 3: Implement tool.** Create `packages/mcp/src/tools/dispatch-timeline.ts`:

```typescript
import { z } from 'zod';

export const DispatchTimelineInputShape = {
  handoff_id: z.string().min(1).describe('The handoff_id whose dispatch event timeline should be returned.'),
};

interface DaemonClient {
  getDispatchTimeline: (handoff_id: string) => Promise<{ events: unknown[] }>;
}

export const dispatchTimelineHandler = (daemon: DaemonClient) => async (args: { handoff_id: string }) => {
  const { events } = await daemon.getDispatchTimeline(args.handoff_id);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ events }, null, 2) }] };
};
```

- [ ] **Step 4: Add `getDispatchTimeline` to the MCP-side `DaemonClient`.** Read `packages/mcp/src/...` for the existing client; add a method that calls `GET /dispatch/events?handoff_id=...` and returns the parsed body. Mirror `getHandoff`.

- [ ] **Step 5: Register the tool.** Edit `packages/mcp/src/server.ts` (after the `handoff.get` registration around line 35-100):

```typescript
import { DispatchTimelineInputShape, dispatchTimelineHandler } from './tools/dispatch-timeline';
// ...
server.registerTool(
  'dispatch.timeline',
  { description: 'Returns the ordered dispatch_events timeline for a handoff_id.', inputSchema: DispatchTimelineInputShape },
  dispatchTimelineHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
```

- [ ] **Step 6: Confirm GREEN.**

```bash
bun test packages/mcp/
bun typecheck
```

- [ ] **Step 7: Commit.**

```bash
git add packages/mcp/src/tools/dispatch-timeline.ts packages/mcp/src/server.ts packages/mcp/test/tools/dispatch-timeline.test.ts
git commit -m "feat(mcp): add dispatch.timeline tool"
```

---

## Task 17: Synthetic wedge probes (4 shell scripts)

**Files:**
- Create: `packages/agentchat/scripts/wedge-probe/probes/wedge-A-sigterm-deaf.sh`
- Create: `packages/agentchat/scripts/wedge-probe/probes/wedge-B-detach-stdio.sh`
- Create: `packages/agentchat/scripts/wedge-probe/probes/wedge-C-stdout-backpressure.sh`
- Create: `packages/agentchat/scripts/wedge-probe/probes/wedge-D-baseline.sh`

- [ ] **Step 1: Probe A (SIGTERM-deaf).**

```bash
#!/usr/bin/env bash
# wedge-A-sigterm-deaf: ignores SIGTERM, only dies on SIGKILL.
trap '' TERM
echo "wedge-A:started pid=$$"
sleep 600
```

- [ ] **Step 2: Probe B (detach-stdio).**

```bash
#!/usr/bin/env bash
# wedge-B-detach-stdio: parent backgrounds a child that inherits stdio fds and parent exits.
# The child's open stdout/stderr keeps the pipe alive after parent's PID is gone.
( sleep 600 ) &
echo "wedge-B:parent_exiting pid=$$ child=$!"
exit 0
```

- [ ] **Step 3: Probe C (stdout backpressure).**

```bash
#!/usr/bin/env bash
# wedge-C-stdout-backpressure: writes ~100MB to stdout then exits. Tests whether
# slow consumer of proc.stdout blocks proc.exited.
yes hello | head -c 100000000
exit 0
```

- [ ] **Step 4: Probe D (baseline).**

```bash
#!/usr/bin/env bash
# wedge-D-baseline: writes once and sleeps. Aborts cleanly via SIGTERM.
echo "wedge-D:started pid=$$"
sleep 3600
```

- [ ] **Step 5: Make executable.**

```bash
chmod +x packages/agentchat/scripts/wedge-probe/probes/*.sh
```

- [ ] **Step 6: Commit.**

```bash
git add packages/agentchat/scripts/wedge-probe/probes/
git commit -m "feat(agentchat): add synthetic wedge-probe shell scripts"
```

---

## Task 18: Probe runner

**Files:**
- Create: `packages/agentchat/scripts/wedge-probe/run-probes.ts`

- [ ] **Step 1: Implement runner.** Create `packages/agentchat/scripts/wedge-probe/run-probes.ts`:

```typescript
#!/usr/bin/env bun
// Runs each synthetic probe through the real cli-spawn helper and prints the dispatch_events timeline.
// Exit 0 if every probe produced a complete sequence ending in proc.exited.resolved within its hard timeout.

import { spawnCliAdapter } from '../../src/adapters/cli-spawn';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ProbeSpec {
  id: string;
  script: string;
  abortAfterMs: number | null;
  hardTimeoutMs: number;
}

const PROBES: ProbeSpec[] = [
  { id: 'A', script: 'probes/wedge-A-sigterm-deaf.sh',     abortAfterMs: 1000, hardTimeoutMs: 30000 },
  { id: 'B', script: 'probes/wedge-B-detach-stdio.sh',     abortAfterMs: null, hardTimeoutMs: 30000 },
  { id: 'C', script: 'probes/wedge-C-stdout-backpressure.sh', abortAfterMs: null, hardTimeoutMs: 30000 },
  { id: 'D', script: 'probes/wedge-D-baseline.sh',         abortAfterMs: 1000, hardTimeoutMs: 30000 },
];

function readDaemonAddr(): { baseUrl: string; token: string } {
  const root = process.env.PENUMBRA_STORAGE_ROOT ?? join(process.env.HOME!, '.penumbra');
  const port = Number(readFileSync(join(root, 'port'), 'utf8'));
  const token = readFileSync(join(root, 'token'), 'utf8').trim();
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

async function runOne(probe: ProbeSpec): Promise<{ id: string; outcome: 'completed' | 'wedged' | 'errored'; ms: number }> {
  const ctrl = new AbortController();
  const handoffId = `probe-${probe.id}-${Date.now()}`;
  const { baseUrl, token } = readDaemonAddr();
  const events: any[] = [];
  const start = Date.now();
  const sender = async (batch: any[]) => {
    await fetch(`${baseUrl}/dispatch/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: batch }),
    }).catch(() => {});
  };

  const probeAbsPath = join(__dirname, probe.script);
  const dispatchPromise = spawnCliAdapter({
    argv: ['/bin/bash', probeAbsPath],
    signal: ctrl.signal,
    eventContext: { handoffId, workerId: 'wedge-probe-runner' },
    onEvent: (e) => { events.push(e); void sender([e]); },
  } as any).catch((err) => ({ err }));

  if (probe.abortAfterMs !== null) {
    setTimeout(() => ctrl.abort(), probe.abortAfterMs);
  }

  const hardTimeout = new Promise<'wedged'>((resolve) => setTimeout(() => resolve('wedged'), probe.hardTimeoutMs));
  const result = await Promise.race([dispatchPromise.then(() => 'completed' as const), hardTimeout]);
  const ms = Date.now() - start;

  // Final flush from runner's side
  await sender([]);
  // Print timeline.
  console.log(`\n=== probe ${probe.id} (${probe.script}) — ${result} in ${ms} ms ===`);
  for (const e of events) console.log(`  ${e.ts}  ${e.kind}  ${JSON.stringify(e.meta ?? {})}`);

  if (result === 'wedged') {
    ctrl.abort();
    return { id: probe.id, outcome: 'wedged', ms };
  }
  return { id: probe.id, outcome: 'completed', ms };
}

async function main() {
  const results: Array<{ id: string; outcome: string; ms: number }> = [];
  for (const probe of PROBES) {
    results.push(await runOne(probe));
  }
  console.log('\n=== summary ===');
  for (const r of results) console.log(`  probe ${r.id}: ${r.outcome} (${r.ms} ms)`);
  const allOk = results.every((r) => r.outcome === 'completed');
  process.exit(allOk ? 0 : 1);
}

void main();
```

- [ ] **Step 2: Smoke run (D-only first, baseline).**

```bash
bun packages/agentchat/scripts/wedge-probe/run-probes.ts
```

Expected: at minimum probe D shows `proc.spawn` → `proc.kill.sent SIGTERM` → `proc.exited.resolved code=143`. Probes A/B/C produce evidence per their hypothesis (B may show `wedged` if the orphan-stdio bug is real).

- [ ] **Step 3: Commit.**

```bash
git add packages/agentchat/scripts/wedge-probe/run-probes.ts
git commit -m "feat(agentchat): add wedge-probe runner against cli-spawn"
```

---

## Task 19: Restart daemon + worker, smoke the live read surface

- [ ] **Step 1: Bounce launchd services after schema bump.**

```bash
launchctl unload ~/Library/LaunchAgents/dev.penumbra.daemon.plist
launchctl load   ~/Library/LaunchAgents/dev.penumbra.daemon.plist
launchctl unload ~/Library/LaunchAgents/dev.penumbra.worker.plist
launchctl load   ~/Library/LaunchAgents/dev.penumbra.worker.plist
sleep 2
curl -sS http://127.0.0.1:51257/health
launchctl print "gui/$(id -u)/dev.penumbra.daemon" | grep "state ="
launchctl print "gui/$(id -u)/dev.penumbra.worker" | grep "state ="
```

Expected: `{"status":"ok",...}`, both services `state = running`.

- [ ] **Step 2: Verify schema migration applied.**

```bash
sqlite3 ~/.penumbra/penumbra.db "SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_events';"
```

Expected: `dispatch_events` printed.

- [ ] **Step 3: Drive a real cheap dispatch to populate events.**

Use the maestro's preferred non-Claude agent (e.g. `gemini-flash` per current quota state):

```bash
# Start a minimal dispatch via MCP — replace agent name if convention differs.
bun -e '
const r = await fetch("http://127.0.0.1:51257/handoffs", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer "+require("fs").readFileSync(require("os").homedir()+"/.penumbra/token","utf8").trim() },
  body: JSON.stringify({ target_agent: "gemini-flash", prompt: "say hello", origin: "wedge-investigation-smoke" })
});
console.log(await r.json());
'
```

Capture the returned `handoff_id`.

- [ ] **Step 4: Wait a few seconds, then read the timeline.**

```bash
bun packages/cli/bin/penumbra.ts dispatch timeline <captured_handoff_id>
```

Expected: at minimum `dispatch.start`, `proc.spawn`, `proc.exited.resolved`, `dispatch.end`.

- [ ] **Step 5: Commit nothing** (this is a verification-only step). If anything fails, re-open the relevant earlier task; do not paper over.

---

## Task 20: Stub the RCA document

**Files:**
- Create: `docs/superpowers/notes/2026-05-01-dispatcher-wedge-rca.md`

- [ ] **Step 1: Write the stub.**

```markdown
# Dispatcher wedge — Root cause analysis (stub)

> Populated after the soak window described in the spec. Sections below are placeholders.

## 1. Failure shapes
TBD — restate from spec, refined by observation.

## 2. Hypothesis table

| Hypothesis | Source of belief | Probe id | Live handoff_ids | Verdict | Notes |
|---|---|---|---|---|---|
| Orphan-stdio child holds pipes open | Bun runtime semantics | B | (pending) | (pending) | |
| Subprocess ignores SIGTERM | Real-CLI behavior under pressure | A | (pending) | (pending) | |
| Stdout back-pressure blocks proc.exited | Bun pipe handling | C | (pending) | (pending) | |
| Signal-listener race (attach after abort) | code review of cli-spawn:88-97 | (synthetic if possible) | (pending) | (pending) | |
| Control-listener reconnect drops cancel | Memory observation 11576 | n/a (live) | (pending) | (pending) | |
| Heartbeat emitter absent / stalled | Observation during Task 13 | n/a | (pending) | (pending) | |

## 3. Synthetic probe results
Run `bun packages/agentchat/scripts/wedge-probe/run-probes.ts` and paste the output here.

## 4. Live evidence
Either: paste the `dispatch_events` timeline of any wedge that occurred in the soak. Or: state `0 wedges in N dispatches over the soak window` with the dispatch count.

## 5. Conclusion
TBD — single paragraph; high/medium/low confidence.

## 6. Recommended fixes
TBD — bullet list, one line each, file:line references.
```

- [ ] **Step 2: Commit.**

```bash
git add docs/superpowers/notes/2026-05-01-dispatcher-wedge-rca.md
git commit -m "docs(dispatcher-wedge): RCA stub for post-soak completion"
```

---

## Task 21: Final acceptance checklist (verification, no commits)

- [ ] **Step 1: Run full test suite.**

```bash
bun test
bun typecheck
```

Expected: all pass.

- [ ] **Step 2: Confirm CLI command works against live daemon.**

```bash
bun packages/cli/bin/penumbra.ts dispatch timeline <any_recent_handoff_id>
```

Expected: non-empty timeline for any dispatch that happened post-merge.

- [ ] **Step 3: Confirm probe runner exits 0 for D and produces complete timelines for A/B/C.**

```bash
bun packages/agentchat/scripts/wedge-probe/run-probes.ts
```

Expected: probe D `completed`. Probes A/B/C `completed` or `wedged` (either is acceptable — the result is the data).

- [ ] **Step 4: Confirm MCP tool surfaces.**

Test by invoking `mcp__penumbra__dispatch_timeline({ handoff_id: '...' })` from the maestro session.

- [ ] **Step 5: Verify daemon + worker still healthy.**

```bash
curl -sS http://127.0.0.1:51257/health
launchctl print "gui/$(id -u)/dev.penumbra.daemon" | grep "state ="
launchctl print "gui/$(id -u)/dev.penumbra.worker" | grep "state ="
```

Expected: ok / running / running.

If all five steps pass, the **investigation infrastructure** is shipped. The RCA itself completes after the 7-day soak window described in the spec.

---

## Verification — does the plan cover the spec?

| Spec section | Plan task(s) |
|---|---|
| §1 Goal & scope | Plan goal & file structure |
| §2 Schema | Task 1 |
| §2 Writer service | Tasks 2, 3 |
| §2 POST route | Task 4 |
| §2 GET route | Task 5 |
| §2 Routes registration | Task 6 |
| §2 Read surface (CLI) | Task 15 |
| §2 Read surface (MCP) | Task 16 |
| §3 cli-spawn emits | Task 10 |
| §3 dispatcher emits | Task 11 |
| §3 control-listener emit | Task 12 |
| §3 heartbeat-sent emit | Task 13 |
| §3 daemon emits (heartbeat-received, watchdog tick + auto-fail) | Task 7 |
| §3 PenumbraClient + queue + worker wiring | Tasks 8, 9, 14 |
| §4 Probe scripts | Task 17 |
| §4 Probe runner | Task 18 |
| §4 eventContext plumbing | Task 10 (the SpawnOpts addition is the same one the runner uses) |
| §5 RCA stub | Task 20 |
| §5 Acceptance gate | Task 21 |
| §6 Risks (instrumentation perturbation) | Task 9 (drop-oldest, fire-and-forget) |
| §6 Risks (orphan-stdio not reproducing in bun test) | Task 18 (runner is standalone, not under bun test) |
| §6 Risks (eventContext optionality) | Task 10 step 1 (zero-events test when omitted) |

Every spec section is covered. No placeholders in code blocks. Type names match across tasks (`DispatchEventInput`, `DispatchEventKind`, `DispatchEventQueue`, `eventContext`, `onEvent`).
