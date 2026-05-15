# Dispatch and Agent Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliability contract for Penumbra dispatches so every handoff can be audited, classified, verified, and used as routing evidence.

**Architecture:** Add a pure core classifier that joins handoff state, dispatch events, response presence, worktree activity, and reconciliation evidence into a `DispatchReliabilityReport`. Expose that report through daemon, CLI, and MCP surfaces, then feed the same classification into smoke tests, agent performance capture, and maestro guardrails. This plan intentionally starts with read-only audit surfaces before changing routing behavior.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, existing Penumbra core/daemon/cli/mcp/agentchat packages, zod schemas, existing MCP server patterns.

**Spec:** `docs/superpowers/specs/2026-05-01-dispatch-and-agent-reliability-design.md`

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Verify/modify | `docs/superpowers/plans/2026-05-01-dispatcher-wedge-investigation.md` | Prerequisite `dispatch_events` foundation if the current checkout does not already include it |
| Create | `packages/core/src/services/dispatch-reliability.ts` | Pure classifier and report types |
| Create | `packages/core/test/services/dispatch-reliability.test.ts` | Classifier unit tests |
| Modify | `packages/core/src/index.ts` | Export classifier types and helper |
| Create | `packages/daemon/src/routes/dispatch-audit.ts` | HTTP route for reliability report |
| Modify | `packages/daemon/src/serve.ts` | Register audit route |
| Create | `packages/daemon/test/routes/dispatch-audit.test.ts` | Route tests |
| Create | `packages/cli/src/commands/dispatch-audit.ts` | CLI command implementation |
| Modify | `packages/cli/bin/penumbra.ts` | Register `dispatch audit` |
| Create | `packages/cli/test/dispatch-audit.test.ts` | CLI formatting tests |
| Create | `packages/mcp/src/tools/dispatch-audit.ts` | MCP tool handler |
| Modify | `packages/mcp/src/server.ts` | Register `dispatch.audit` |
| Create | `packages/mcp/test/dispatch-audit.test.ts` | MCP tool tests |
| Create | `packages/agentchat/scripts/reliability-smoke/run.ts` | Worker-path smoke runner |
| Create | `packages/agentchat/scripts/reliability-smoke/fixtures/fake-agent.js` | Fake CLI agent fixture |
| Create | `packages/agentchat/test/integration/reliability-smoke.test.ts` | Smoke harness integration tests |
| Modify | `packages/core/src/db/schema.ts` | Add reliability fields to `agent_performance` |
| Modify | `packages/core/src/writers/agent-performance.ts` | Persist reliability fields |
| Modify | `packages/core/src/readers/agent-rank.ts` | Include trust evidence in candidate output |
| Modify | `packages/core/test/writers/agent-performance.test.ts` | Writer tests for reliability fields |
| Modify | `packages/core/test/readers/agent-rank.test.ts` | Ranking tests for trust score |
| Modify | `packages/daemon/src/routes/handoffs.ts` | Include audit recommendation in lean status |
| Modify | `packages/mcp/src/tools/chain-status.ts` | Include reliability recommendation in MCP status |
| Modify | `packages/daemon/test/routes/handoffs-status.test.ts` | Status route tests |
| Modify | `packages/mcp/test/chain-status.test.ts` | MCP status tests |
| Create | `docs/superpowers/notes/2026-05-01-dispatch-reliability-soak.md` | Soak protocol and results template |

---

## Task 0: Prerequisite Dispatch Events Foundation

**Files:**
- Verify/modify according to: `docs/superpowers/plans/2026-05-01-dispatcher-wedge-investigation.md`
- Expected existing symbols after completion:
  - `packages/core/src/db/schema.ts` contains `dispatch_events`
  - `packages/core/src/services.ts` exposes `dispatchEventLog`
  - `packages/daemon/src/routes/dispatch-events.ts` exists
  - `packages/daemon/src/serve.ts` registers `GET /dispatch/events`
  - `packages/daemon/src/serve.ts` registers `POST /dispatch/events`

- [ ] **Step 1: Check whether dispatch events are already implemented**

Run:

```bash
rg -n "dispatchEventLog|DispatchEventLog|dispatch_events|listByHandoff|recordBatch" packages/core packages/daemon
```

Expected if prerequisite is present: matches in core schema/services, daemon route/service, and tests.

- [ ] **Step 2: If the check fails, execute the existing wedge instrumentation plan first**

Open and execute:

```text
docs/superpowers/plans/2026-05-01-dispatcher-wedge-investigation.md
```

Required stopping point: complete the schema, writer, route, service wiring, worker event queue, and `dispatch_events` timeline read surface tasks. The RCA and 1-week soak from that older plan can remain separate; this reliability plan only depends on the event storage and read path.

- [ ] **Step 3: Verify prerequisite tests**

Run the focused tests created by the wedge plan:

```bash
bun test packages/core/test/db/schema-dispatch-events.test.ts
bun test packages/daemon/test/routes/dispatch-events.test.ts
bun test packages/agentchat/test/worker/event-queue.test.ts
bun typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 4: Commit prerequisite if it was newly implemented**

```bash
git add packages/core packages/daemon packages/agentchat
git commit -m "feat(agentchat): add dispatch event timeline foundation"
```

If the prerequisite already existed before this plan, do not create an empty commit.

---

## Task 1: Core Reliability Classifier

**Files:**
- Create: `packages/core/src/services/dispatch-reliability.ts`
- Create: `packages/core/test/services/dispatch-reliability.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing classifier tests**

Create `packages/core/test/services/dispatch-reliability.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  classifyDispatchReliability,
  type DispatchReliabilityInput,
} from '../../src/services/dispatch-reliability';

function baseInput(overrides: Partial<DispatchReliabilityInput> = {}): DispatchReliabilityInput {
  return {
    handoff: {
      handoff_id: 'h-1',
      status: 'completed',
      ts: '2026-05-01T00:00:00.000Z',
      resolved_at: '2026-05-01T00:00:10.000Z',
      cancel_requested_at: null,
      chain_task_type: 'implement_small',
      use_worktree: 1,
    },
    events: [
      { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
      { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
      { kind: 'proc.exited.resolved', ts: '2026-05-01T00:00:08.000Z' },
      { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z', meta: { status: 'ok' } },
    ],
    responseCount: 1,
    finalResponseText: 'DONE',
    worktreeChanged: true,
    reconciled: true,
    adapterStreaming: true,
    now: new Date('2026-05-01T00:00:20.000Z'),
    staleAfterMs: 120_000,
    ...overrides,
  };
}

describe('classifyDispatchReliability', () => {
  test('returns complete for a terminal handoff with lifecycle and artifact evidence', () => {
    const report = classifyDispatchReliability(baseInput());
    expect(report.status).toBe('complete');
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe('accept');
    expect(report.missing_events).toEqual([]);
  });

  test('detects missing dispatch.start', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z' },
      ],
    }));
    expect(report.status).toBe('missing_dispatch_start');
    expect(report.trustworthy).toBe(false);
    expect(report.missing_events).toEqual(['dispatch.start']);
  });

  test('detects missing adapter lifecycle', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z' },
      ],
    }));
    expect(report.status).toBe('missing_adapter_lifecycle');
    expect(report.missing_events).toContain('adapter.lifecycle');
  });

  test('detects missing dispatch.end', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'proc.exited.resolved', ts: '2026-05-01T00:00:08.000Z' },
      ],
    }));
    expect(report.status).toBe('missing_dispatch_end');
    expect(report.missing_events).toEqual(['dispatch.end']);
  });

  test('detects stale non-terminal handoff', () => {
    const report = classifyDispatchReliability(baseInput({
      handoff: {
        handoff_id: 'h-1',
        status: 'dispatched',
        ts: '2026-05-01T00:00:00.000Z',
        resolved_at: null,
        cancel_requested_at: null,
        chain_task_type: 'implement_small',
        use_worktree: 1,
      },
      events: [{ kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' }],
      now: new Date('2026-05-01T00:05:00.000Z'),
    }));
    expect(report.status).toBe('non_terminal_stale');
    expect(report.recommended_action).toBe('inspect_worktree');
  });

  test('detects cancel-requested handoff that completed', () => {
    const report = classifyDispatchReliability(baseInput({
      handoff: {
        handoff_id: 'h-1',
        status: 'completed',
        ts: '2026-05-01T00:00:00.000Z',
        resolved_at: '2026-05-01T00:00:10.000Z',
        cancel_requested_at: '2026-05-01T00:00:05.000Z',
        chain_task_type: 'implement_small',
        use_worktree: 1,
      },
    }));
    expect(report.status).toBe('cancel_completed');
    expect(report.trustworthy).toBe(false);
  });

  test('detects watchdog-only failure', () => {
    const report = classifyDispatchReliability(baseInput({
      handoff: {
        handoff_id: 'h-1',
        status: 'failed',
        ts: '2026-05-01T00:00:00.000Z',
        resolved_at: '2026-05-01T00:01:00.000Z',
        cancel_requested_at: null,
        chain_task_type: 'implement_small',
        use_worktree: 1,
      },
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'watchdog.auto_fail', ts: '2026-05-01T00:01:00.000Z' },
      ],
    }));
    expect(report.status).toBe('watchdog_only');
    expect(report.recommended_action).toBe('retry');
  });

  test('detects empty agent output', () => {
    const report = classifyDispatchReliability(baseInput({
      responseCount: 0,
      finalResponseText: '',
    }));
    expect(report.status).toBe('no_agent_output');
    expect(report.recommended_action).toBe('retry');
  });

  test('detects implementation completion without artifact evidence', () => {
    const report = classifyDispatchReliability(baseInput({
      worktreeChanged: false,
      reconciled: false,
    }));
    expect(report.status).toBe('no_worktree_activity');
    expect(report.recommended_action).toBe('review_manually');
  });

  test('detects changed worktree with missing reconciliation', () => {
    const report = classifyDispatchReliability(baseInput({
      worktreeChanged: true,
      reconciled: false,
    }));
    expect(report.status).toBe('reconcile_missing');
  });
});
```

- [ ] **Step 2: Run tests to confirm RED**

Run:

```bash
bun test packages/core/test/services/dispatch-reliability.test.ts
```

Expected: import failure because `dispatch-reliability.ts` does not exist.

- [ ] **Step 3: Implement the classifier**

Create `packages/core/src/services/dispatch-reliability.ts`:

```ts
export type DispatchReliabilityStatus =
  | 'complete'
  | 'missing_dispatch_start'
  | 'missing_adapter_lifecycle'
  | 'missing_dispatch_end'
  | 'non_terminal_stale'
  | 'cancel_completed'
  | 'watchdog_only'
  | 'no_agent_output'
  | 'no_worktree_activity'
  | 'reconcile_missing'
  | 'agent_declared_done_unverified'
  | 'timeline_inconsistent';

export type DispatchRecommendedAction =
  | 'wait'
  | 'inspect_worktree'
  | 'cancel'
  | 'retry'
  | 'review_manually'
  | 'accept';

export interface DispatchReliabilityEvent {
  kind: string;
  ts: string;
  meta?: unknown;
}

export interface DispatchReliabilityHandoff {
  handoff_id: string;
  status: string;
  ts: string;
  resolved_at: string | null;
  cancel_requested_at: string | null;
  chain_task_type?: string | null;
  use_worktree?: boolean | number | null;
}

export interface DispatchReliabilityInput {
  handoff: DispatchReliabilityHandoff;
  events: DispatchReliabilityEvent[];
  responseCount: number;
  finalResponseText: string | null;
  worktreeChanged: boolean | null;
  reconciled: boolean | null;
  adapterStreaming: boolean | null;
  now?: Date;
  staleAfterMs?: number;
}

export interface DispatchReliabilityReport {
  handoff_id: string;
  status: DispatchReliabilityStatus;
  terminal: boolean;
  trustworthy: boolean;
  summary: string;
  missing_events: string[];
  evidence: {
    handoff_status: string;
    event_count: number;
    response_count: number;
    worktree_changed: boolean | null;
    reconciled: boolean | null;
    watchdog_failed: boolean;
    cancel_requested: boolean;
    adapter_streaming: boolean | null;
  };
  recommended_action: DispatchRecommendedAction;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rejected', 'expired']);
const ADAPTER_EVENT_PREFIXES = ['proc.', 'http.', 'acp.'];

export function classifyDispatchReliability(input: DispatchReliabilityInput): DispatchReliabilityReport {
  const eventKinds = input.events.map((event) => event.kind);
  const has = (kind: string) => eventKinds.includes(kind);
  const hasAdapterLifecycle = eventKinds.some((kind) => ADAPTER_EVENT_PREFIXES.some((prefix) => kind.startsWith(prefix)));
  const terminal = TERMINAL_STATUSES.has(input.handoff.status);
  const cancelRequested = input.handoff.cancel_requested_at !== null;
  const watchdogFailed = has('watchdog.auto_fail');
  const missing: string[] = [];

  if (!has('dispatch.start')) missing.push('dispatch.start');
  if (!hasAdapterLifecycle) missing.push('adapter.lifecycle');
  if (!has('dispatch.end')) missing.push('dispatch.end');

  const baseEvidence = {
    handoff_status: input.handoff.status,
    event_count: input.events.length,
    response_count: input.responseCount,
    worktree_changed: input.worktreeChanged,
    reconciled: input.reconciled,
    watchdog_failed: watchdogFailed,
    cancel_requested: cancelRequested,
    adapter_streaming: input.adapterStreaming,
  };

  const report = (
    status: DispatchReliabilityStatus,
    trustworthy: boolean,
    summary: string,
    recommended_action: DispatchRecommendedAction,
    missing_events = missing,
  ): DispatchReliabilityReport => ({
    handoff_id: input.handoff.handoff_id,
    status,
    terminal,
    trustworthy,
    summary,
    missing_events,
    evidence: baseEvidence,
    recommended_action,
  });

  if (!terminal && isStale(input)) {
    return report(
      'non_terminal_stale',
      false,
      'handoff is non-terminal past the stale threshold',
      input.adapterStreaming === false ? 'inspect_worktree' : 'cancel',
      [],
    );
  }

  if (cancelRequested && input.handoff.status === 'completed') {
    return report('cancel_completed', false, 'cancel-requested handoff completed', 'review_manually', []);
  }

  if (watchdogFailed && !has('dispatch.end')) {
    return report('watchdog_only', false, 'watchdog failed the handoff without dispatch.end', 'retry', ['dispatch.end']);
  }

  if (!has('dispatch.start')) {
    return report('missing_dispatch_start', false, 'dispatch.start event is missing', 'review_manually', ['dispatch.start']);
  }

  if (!hasAdapterLifecycle) {
    return report('missing_adapter_lifecycle', false, 'adapter lifecycle event is missing', 'review_manually', ['adapter.lifecycle']);
  }

  if (!has('dispatch.end')) {
    return report('missing_dispatch_end', false, 'dispatch.end event is missing', terminal ? 'review_manually' : 'wait', ['dispatch.end']);
  }

  if (terminal && input.responseCount === 0 && !input.finalResponseText?.trim()) {
    return report('no_agent_output', false, 'terminal handoff has no agent output', 'retry', []);
  }

  if (isImplementationTask(input.handoff) && terminal && input.worktreeChanged === false) {
    return report('no_worktree_activity', false, 'implementation task completed without worktree activity', 'review_manually', []);
  }

  if (isImplementationTask(input.handoff) && terminal && input.worktreeChanged === true && input.reconciled === false) {
    return report('reconcile_missing', false, 'implementation task changed files but lacks reconciliation evidence', 'review_manually', []);
  }

  if (hasImpossibleOrder(input.events)) {
    return report('timeline_inconsistent', false, 'dispatch timeline has impossible event ordering', 'review_manually', []);
  }

  if (!terminal) {
    return report('complete', false, 'handoff is still running and not stale', 'wait', []);
  }

  return report('complete', true, 'dispatch lifecycle and result evidence are complete', 'accept', []);
}

function isStale(input: DispatchReliabilityInput): boolean {
  const staleAfterMs = input.staleAfterMs ?? 120_000;
  const now = input.now ?? new Date();
  return now.getTime() - new Date(input.handoff.ts).getTime() > staleAfterMs;
}

function isImplementationTask(handoff: DispatchReliabilityHandoff): boolean {
  const taskType = handoff.chain_task_type ?? '';
  return taskType === 'implement_small' || taskType === 'implement_substantial' || handoff.use_worktree === true || handoff.use_worktree === 1;
}

function hasImpossibleOrder(events: DispatchReliabilityEvent[]): boolean {
  const start = firstIndex(events, 'dispatch.start');
  const end = firstIndex(events, 'dispatch.end');
  return start >= 0 && end >= 0 && end < start;
}

function firstIndex(events: DispatchReliabilityEvent[], kind: string): number {
  return events.findIndex((event) => event.kind === kind);
}
```

Modify `packages/core/src/index.ts`:

```ts
export {
  classifyDispatchReliability,
  type DispatchReliabilityEvent,
  type DispatchReliabilityHandoff,
  type DispatchReliabilityInput,
  type DispatchReliabilityReport,
  type DispatchReliabilityStatus,
  type DispatchRecommendedAction,
} from './services/dispatch-reliability.js';
```

- [ ] **Step 4: Run tests to confirm GREEN**

Run:

```bash
bun test packages/core/test/services/dispatch-reliability.test.ts
bun typecheck
```

Expected: classifier tests pass and typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/dispatch-reliability.ts packages/core/test/services/dispatch-reliability.test.ts packages/core/src/index.ts
git commit -m "feat(core): classify dispatch reliability"
```

---

## Task 2: Daemon Dispatch Audit Route

**Files:**
- Create: `packages/daemon/src/routes/dispatch-audit.ts`
- Modify: `packages/daemon/src/serve.ts`
- Create: `packages/daemon/test/routes/dispatch-audit.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `packages/daemon/test/routes/dispatch-audit.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { dispatchAuditRoute } from '../../src/routes/dispatch-audit';

function services() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/dispatch-audit-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    uuid: () => `id-${++n}`,
  });
}

describe('dispatchAuditRoute', () => {
  test('returns 400 when handoff_id is missing', async () => {
    const svc = services();
    const res = await dispatchAuditRoute(new Request('http://x/dispatch/audit'), svc);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_handoff_id' });
  });

  test('returns 404 for unknown handoff', async () => {
    const svc = services();
    const res = await dispatchAuditRoute(new Request('http://x/dispatch/audit?handoff_id=h-missing'), svc);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'handoff_not_found' });
  });

  test('returns reliability report for known handoff', async () => {
    const svc = services();
    svc.handoffWriter.create({
      handoff_id: 'h-1',
      ts: '2026-05-01T00:00:00.000Z',
      from: 'user',
      to: 'codex',
      to_role: null,
      message: 'Task type: implement_small\n\nchange it',
      conversation_id: 'c-1',
      project_id: null,
      triggered_by_event_id: 'e-1',
      use_worktree: true,
      chain_task_type: 'implement_small',
    });
    svc.handoffWriter.approve('h-1', { resolved_by: 'test', resolved_at: '2026-05-01T00:00:01.000Z' });
    svc.handoffWriter.claimDispatch('h-1', 'worker-1');
    svc.handoffWriter.markCompleted('h-1', { ts: '2026-05-01T00:00:10.000Z' });
    svc.dispatchEventLog.recordBatch([
      { handoff_id: 'h-1', worker_id: 'worker-1', source: 'worker', kind: 'dispatch.start', ts: '2026-05-01T00:00:02.000Z' },
      { handoff_id: 'h-1', worker_id: 'worker-1', source: 'worker', kind: 'proc.spawn', ts: '2026-05-01T00:00:03.000Z' },
      { handoff_id: 'h-1', worker_id: 'worker-1', source: 'worker', kind: 'proc.exited.resolved', ts: '2026-05-01T00:00:08.000Z' },
      { handoff_id: 'h-1', worker_id: 'worker-1', source: 'worker', kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z' },
    ]);

    const res = await dispatchAuditRoute(new Request('http://x/dispatch/audit?handoff_id=h-1'), svc);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.handoff_id).toBe('h-1');
    expect(body.report.status).toBe('no_agent_output');
    expect(body.report.trustworthy).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm RED**

Run:

```bash
bun test packages/daemon/test/routes/dispatch-audit.test.ts
```

Expected: import failure because route does not exist.

- [ ] **Step 3: Implement route**

Create `packages/daemon/src/routes/dispatch-audit.ts`:

```ts
import type { Services } from '@penumbra/core';
import { classifyDispatchReliability } from '@penumbra/core';

export async function dispatchAuditRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const handoffId = url.searchParams.get('handoff_id');
  if (!handoffId) return json({ error: 'missing_handoff_id' }, 400);

  const handoff = services.handoffReader.get(handoffId);
  if (!handoff) return json({ error: 'handoff_not_found' }, 404);

  const events = services.dispatchEventLog.listByHandoff(handoffId).map((event) => ({
    kind: event.kind,
    ts: event.ts,
    meta: event.meta,
  }));
  const responses = services.chainReader.getResponses(handoff.conversation_id, 'final');
  const finalResponseText = responses.at(-1)?.text ?? null;

  const report = classifyDispatchReliability({
    handoff: {
      handoff_id: handoff.handoff_id,
      status: handoff.status,
      ts: handoff.ts,
      resolved_at: handoff.resolved_at,
      cancel_requested_at: handoff.cancel_requested_at,
      chain_task_type: handoff.chain_task_type,
      use_worktree: handoff.use_worktree,
    },
    events,
    responseCount: responses.length,
    finalResponseText,
    worktreeChanged: null,
    reconciled: null,
    adapterStreaming: null,
    now: services.clock(),
  });

  return json({ report });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

Modify `packages/daemon/src/serve.ts` where routes are registered:

```ts
import { dispatchAuditRoute } from './routes/dispatch-audit.js';
```

Add route handling near the other dispatch routes:

```ts
if (url.pathname === '/dispatch/audit' && req.method === 'GET') {
  return dispatchAuditRoute(req, services);
}
```

- [ ] **Step 4: Run tests to confirm GREEN**

Run:

```bash
bun test packages/daemon/test/routes/dispatch-audit.test.ts
bun typecheck
```

Expected: route tests pass and typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/dispatch-audit.ts packages/daemon/src/serve.ts packages/daemon/test/routes/dispatch-audit.test.ts
git commit -m "feat(daemon): expose dispatch audit route"
```

---

## Task 3: CLI Dispatch Audit Command

**Files:**
- Create: `packages/cli/src/commands/dispatch-audit.ts`
- Modify: `packages/cli/bin/penumbra.ts`
- Create: `packages/cli/test/dispatch-audit.test.ts`

- [ ] **Step 1: Write failing formatting tests**

Create `packages/cli/test/dispatch-audit.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { formatDispatchAudit } from '../src/commands/dispatch-audit';

const report = {
  handoff_id: 'h-1',
  status: 'watchdog_only',
  terminal: true,
  trustworthy: false,
  summary: 'watchdog failed the handoff without dispatch.end',
  missing_events: ['dispatch.end'],
  evidence: {
    handoff_status: 'failed',
    event_count: 3,
    response_count: 0,
    worktree_changed: null,
    reconciled: null,
    watchdog_failed: true,
    cancel_requested: false,
    adapter_streaming: null,
  },
  recommended_action: 'retry',
} as const;

describe('formatDispatchAudit', () => {
  test('formats human-readable audit output', () => {
    expect(formatDispatchAudit(report)).toBe([
      'handoff: h-1',
      'status: watchdog_only',
      'trustworthy: no',
      'summary: watchdog failed the handoff without dispatch.end',
      'recommended_action: retry',
      'missing_events: dispatch.end',
    ].join('\n'));
  });

  test('formats empty missing events as none', () => {
    expect(formatDispatchAudit({ ...report, missing_events: [] })).toContain('missing_events: none');
  });
});
```

- [ ] **Step 2: Run tests to confirm RED**

Run:

```bash
bun test packages/cli/test/dispatch-audit.test.ts
```

Expected: import failure because command does not exist.

- [ ] **Step 3: Implement CLI helper and command**

Create `packages/cli/src/commands/dispatch-audit.ts`:

```ts
import type { DispatchReliabilityReport } from '@penumbra/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Branding } from '@penumbra/core';
import { resolveCliStorageRoot } from '../storage-root.js';

export function formatDispatchAudit(report: DispatchReliabilityReport): string {
  return [
    `handoff: ${report.handoff_id}`,
    `status: ${report.status}`,
    `trustworthy: ${report.trustworthy ? 'yes' : 'no'}`,
    `summary: ${report.summary}`,
    `recommended_action: ${report.recommended_action}`,
    `missing_events: ${report.missing_events.length > 0 ? report.missing_events.join(', ') : 'none'}`,
  ].join('\n');
}

export async function runDispatchAudit(args: string[]): Promise<void> {
  const handoffId = args.find((arg) => !arg.startsWith('--'));
  const json = args.includes('--json');
  if (!handoffId) {
    throw new Error('usage: penumbra dispatch audit <handoff_id> [--json]');
  }

  const endpoint = readDaemonEndpoint();
  const res = await fetch(`${endpoint.baseUrl}/dispatch/audit?handoff_id=${encodeURIComponent(handoffId)}`, {
    headers: { authorization: `Bearer ${endpoint.token}` },
  });
  if (!res.ok) {
    throw new Error(`dispatch audit failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { report: DispatchReliabilityReport };
  if (json) {
    console.log(JSON.stringify(body.report, null, 2));
  } else {
    console.log(formatDispatchAudit(body.report));
  }
}

function readDaemonEndpoint(): { baseUrl: string; token: string } {
  let storageRoot = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;
  try {
    storageRoot = resolveCliStorageRoot();
  } catch {}
  const portPath = join(storageRoot, 'port');
  const tokenPath = join(storageRoot, 'token');
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    throw new Error(`penumbra dispatch audit: daemon metadata missing under ${storageRoot}`);
  }
  const port = readFileSync(portPath, 'utf8').trim();
  const token = readFileSync(tokenPath, 'utf8').trim();
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}
```

Modify `packages/cli/bin/penumbra.ts`:

```ts
import { runDispatchAudit } from '../src/commands/dispatch-audit.js';
```

In command dispatch:

```ts
case 'dispatch': {
  const sub = process.argv[3];
  if (sub === 'audit') {
    await runDispatchAudit(process.argv.slice(4));
    process.exit(0);
  }
  console.error('usage: penumbra dispatch audit <handoff_id> [--json]');
  process.exit(1);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
bun test packages/cli/test/dispatch-audit.test.ts
bun typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/dispatch-audit.ts packages/cli/bin/penumbra.ts packages/cli/test/dispatch-audit.test.ts
git commit -m "feat(cli): add dispatch audit command"
```

---

## Task 4: MCP Dispatch Audit Tool

**Files:**
- Create: `packages/mcp/src/tools/dispatch-audit.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Modify: `packages/mcp/src/server.ts`
- Create: `packages/mcp/test/dispatch-audit.test.ts`

- [ ] **Step 1: Write failing tool tests**

Create `packages/mcp/test/dispatch-audit.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { DispatchAuditInputShape, dispatchAuditHandler } from '../src/tools/dispatch-audit';

describe('dispatch.audit tool', () => {
  test('input schema requires handoff_id', () => {
    expect(DispatchAuditInputShape.safeParse({ handoff_id: 'h-1' }).success).toBe(true);
    expect(DispatchAuditInputShape.safeParse({}).success).toBe(false);
  });

  test('handler returns daemon report text', async () => {
    const calls: string[] = [];
    const handler = dispatchAuditHandler({
      dispatchAudit: async (handoff_id: string) => {
        calls.push(handoff_id);
        return {
          report: {
            handoff_id: 'h-1',
            status: 'complete',
            terminal: true,
            trustworthy: true,
            summary: 'dispatch lifecycle and result evidence are complete',
            missing_events: [],
            evidence: {
              handoff_status: 'completed',
              event_count: 4,
              response_count: 1,
              worktree_changed: true,
              reconciled: true,
              watchdog_failed: false,
              cancel_requested: false,
              adapter_streaming: true,
            },
            recommended_action: 'accept',
          },
        };
      },
    } as any);

    const result = await handler({ handoff_id: 'h-1' });
    expect(calls).toEqual(['h-1']);
    expect(result.content[0].text).toContain('"status": "complete"');
  });
});
```

- [ ] **Step 2: Run tests to confirm RED**

Run:

```bash
bun test packages/mcp/test/dispatch-audit.test.ts
```

Expected: import failure because tool does not exist.

- [ ] **Step 3: Implement MCP tool**

Create `packages/mcp/src/tools/dispatch-audit.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const DispatchAuditInputShape = z.object({
  handoff_id: z.string().min(1),
});

export function dispatchAuditHandler(daemon: Pick<DaemonClient, 'dispatchAudit'>) {
  return async (input: z.infer<typeof DispatchAuditInputShape>) => {
    const body = await daemon.dispatchAudit(input.handoff_id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  };
}
```

Modify `packages/mcp/src/daemon-client.ts`:

```ts
import type { DispatchReliabilityReport } from '@penumbra/core';
```

Add a public method near `getHandoffStatus()`:

```ts
async dispatchAudit(handoff_id: string): Promise<{ report: DispatchReliabilityReport }> {
  return this.get(`/dispatch/audit?handoff_id=${encodeURIComponent(handoff_id)}`);
}
```

Modify `packages/mcp/src/server.ts`:

```ts
import { DispatchAuditInputShape, dispatchAuditHandler } from './tools/dispatch-audit.js';
```

Register near other dispatch/chain tools:

```ts
server.registerTool(
  'dispatch.audit',
  {
    description: 'Return a reliability audit report for one handoff.',
    inputSchema: DispatchAuditInputShape,
  },
  dispatchAuditHandler(opts.daemon) as unknown as Parameters<McpServer['registerTool']>[2],
);
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
bun test packages/mcp/test/dispatch-audit.test.ts
bun typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/dispatch-audit.ts packages/mcp/src/daemon-client.ts packages/mcp/src/server.ts packages/mcp/test/dispatch-audit.test.ts
git commit -m "feat(mcp): expose dispatch audit tool"
```

---

## Task 5: Worker-Path Reliability Smoke Harness

**Files:**
- Create: `packages/agentchat/scripts/reliability-smoke/fixtures/fake-agent.js`
- Create: `packages/agentchat/scripts/reliability-smoke/run.ts`
- Create: `packages/agentchat/test/integration/reliability-smoke.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `packages/agentchat/test/integration/reliability-smoke.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { runReliabilitySmokeScenario } from '../../scripts/reliability-smoke/run';

describe('reliability smoke scenario classifier expectations', () => {
  test('success_with_output classifies complete', async () => {
    const result = await runReliabilitySmokeScenario('success_with_output', { dryRun: true });
    expect(result.scenario).toBe('success_with_output');
    expect(result.expectedStatus).toBe('complete');
  });

  test('empty_success classifies no_agent_output', async () => {
    const result = await runReliabilitySmokeScenario('empty_success', { dryRun: true });
    expect(result.expectedStatus).toBe('no_agent_output');
  });

  test('implementation_no_diff classifies no_worktree_activity', async () => {
    const result = await runReliabilitySmokeScenario('implementation_no_diff', { dryRun: true });
    expect(result.expectedStatus).toBe('no_worktree_activity');
  });
});
```

- [ ] **Step 2: Run tests to confirm RED**

Run:

```bash
bun test packages/agentchat/test/integration/reliability-smoke.test.ts
```

Expected: import failure because smoke runner does not exist.

- [ ] **Step 3: Implement fake agent fixture**

Create `packages/agentchat/scripts/reliability-smoke/fixtures/fake-agent.js`:

```js
#!/usr/bin/env node

const scenario = process.argv[2] ?? 'success_with_output';

if (scenario === 'success_with_output') {
  process.stdout.write('DONE\n');
  process.exit(0);
}

if (scenario === 'empty_success') {
  process.exit(0);
}

if (scenario === 'stderr_only') {
  process.stderr.write('fake stderr failure\n');
  process.exit(0);
}

if (scenario === 'nonzero_exit') {
  process.stderr.write('fake nonzero failure\n');
  process.exit(2);
}

if (scenario === 'signal_exit') {
  process.kill(process.pid, 'SIGTERM');
}

if (scenario === 'cancel_process_group') {
  setInterval(() => {}, 1000);
}

if (scenario === 'implementation_no_diff') {
  process.stdout.write('DONE\n');
  process.exit(0);
}

if (scenario === 'review_no_sources') {
  process.stdout.write('No findings.\n');
  process.exit(0);
}

process.stderr.write(`unknown scenario: ${scenario}\n`);
process.exit(64);
```

- [ ] **Step 4: Implement smoke runner skeleton**

Create `packages/agentchat/scripts/reliability-smoke/run.ts`:

```ts
import type { DispatchReliabilityStatus } from '@penumbra/core';

export type ReliabilitySmokeScenario =
  | 'success_with_output'
  | 'empty_success'
  | 'stderr_only'
  | 'nonzero_exit'
  | 'signal_exit'
  | 'cancel_process_group'
  | 'implementation_no_diff'
  | 'review_no_sources'
  | 'watchdog_missing_end';

export interface ReliabilitySmokeResult {
  scenario: ReliabilitySmokeScenario;
  expectedStatus: DispatchReliabilityStatus;
  actualStatus: DispatchReliabilityStatus | null;
}

const EXPECTED: Record<ReliabilitySmokeScenario, DispatchReliabilityStatus> = {
  success_with_output: 'complete',
  empty_success: 'no_agent_output',
  stderr_only: 'no_agent_output',
  nonzero_exit: 'complete',
  signal_exit: 'complete',
  cancel_process_group: 'complete',
  implementation_no_diff: 'no_worktree_activity',
  review_no_sources: 'agent_declared_done_unverified',
  watchdog_missing_end: 'watchdog_only',
};

export async function runReliabilitySmokeScenario(
  scenario: ReliabilitySmokeScenario,
  opts: { dryRun?: boolean } = {},
): Promise<ReliabilitySmokeResult> {
  if (opts.dryRun) {
    return { scenario, expectedStatus: EXPECTED[scenario], actualStatus: null };
  }
  throw new Error('live reliability smoke execution is implemented in the next task');
}

if (import.meta.main) {
  const scenarios = Object.keys(EXPECTED) as ReliabilitySmokeScenario[];
  for (const scenario of scenarios) {
    const result = await runReliabilitySmokeScenario(scenario, { dryRun: true });
    console.log(`${result.scenario}\t${result.expectedStatus}`);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun test packages/agentchat/test/integration/reliability-smoke.test.ts
bun typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/scripts/reliability-smoke packages/agentchat/test/integration/reliability-smoke.test.ts
git commit -m "test(agentchat): scaffold reliability smoke scenarios"
```

---

## Task 6: Agent Performance Reliability Fields

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/writers/agent-performance.ts`
- Modify: `packages/core/src/readers/agent-rank.ts`
- Modify: `packages/core/test/writers/agent-performance.test.ts`
- Modify: `packages/core/test/readers/agent-rank.test.ts`

- [ ] **Step 1: Write failing writer test**

Add to `packages/core/test/writers/agent-performance.test.ts`:

```ts
test('stores reliability fields on agent performance rows', () => {
  const writer = new AgentPerformanceWriter(db);
  writer.upsert({
    performance_id: 'p-reliability',
    ts: '2026-05-01T00:00:00.000Z',
    handoff_id: 'h-reliability',
    conversation_id: 'c-1',
    project_id: null,
    agent_name: 'codex',
    task_type: 'implement_small',
    outcome: 'merged',
    source: 'operator',
    reliability_status: 'complete',
    failure_class: null,
    artifact_present: 'y',
    verification_present: 'y',
    maestro_takeover_required: 'n',
    empty_response: 'n',
    worktree_changed: 'y',
    reconcile_status: 'clean',
    environment_failure: 'n',
    trust_score: 0.95,
  });

  const row = db.query<any, []>('SELECT * FROM agent_performance WHERE handoff_id="h-reliability"').get();
  expect(row.reliability_status).toBe('complete');
  expect(row.artifact_present).toBe('y');
  expect(row.trust_score).toBe(0.95);
});
```

- [ ] **Step 2: Run test to confirm RED**

Run:

```bash
bun test packages/core/test/writers/agent-performance.test.ts
```

Expected: type or sqlite errors for missing fields.

- [ ] **Step 3: Add schema columns**

Modify `packages/core/src/db/schema.ts` in `agent_performance` creation and migration/backfill path:

```sql
reliability_status TEXT,
failure_class TEXT,
artifact_present TEXT,
verification_present TEXT,
maestro_takeover_required TEXT,
empty_response TEXT,
worktree_changed TEXT,
reconcile_status TEXT,
environment_failure TEXT,
trust_score REAL,
```

Add idempotent `ALTER TABLE` guards matching the existing migration style for legacy tables.

- [ ] **Step 4: Extend writer input and insert/upsert SQL**

Modify `packages/core/src/writers/agent-performance.ts` so optional fields are accepted and stored:

```ts
reliability_status?: string | null;
failure_class?: string | null;
artifact_present?: 'y' | 'n' | 'n/a' | null;
verification_present?: 'y' | 'n' | 'n/a' | null;
maestro_takeover_required?: 'y' | 'n' | null;
empty_response?: 'y' | 'n' | null;
worktree_changed?: 'y' | 'n' | 'n/a' | null;
reconcile_status?: string | null;
environment_failure?: 'y' | 'n' | null;
trust_score?: number | null;
```

Default missing values to `null`.

- [ ] **Step 5: Add rank reader trust output test**

Add to `packages/core/test/readers/agent-rank.test.ts`:

```ts
test('rankAgents includes average trust score when present', () => {
  seedPerformance(db, {
    performance_id: 'p-trust',
    handoff_id: 'h-trust',
    agent_name: 'codex',
    task_type: 'implement_small',
    outcome: 'merged',
    trust_score: 0.9,
  });
  const result = rankAgents(db, {
    task_type: 'implement_small',
    include_neutral: true,
    include_cost: false,
    min_samples: 1,
  }, clock);
  expect(result.candidates[0].agent_name).toBe('codex');
  expect(result.candidates[0].avg_trust_score).toBe(0.9);
});
```

- [ ] **Step 6: Extend rank reader output**

Modify `packages/core/src/readers/agent-rank.ts` candidate shape with:

```ts
avg_trust_score: number | null;
```

Compute average over rows with non-null `trust_score`.

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
bun test packages/core/test/writers/agent-performance.test.ts packages/core/test/readers/agent-rank.test.ts
bun typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/writers/agent-performance.ts packages/core/src/readers/agent-rank.ts packages/core/test/writers/agent-performance.test.ts packages/core/test/readers/agent-rank.test.ts
git commit -m "feat(core): record agent reliability evidence"
```

---

## Task 7: Chain Status Guardrails

**Files:**
- Modify: `packages/daemon/src/routes/handoffs.ts`
- Modify: `packages/mcp/src/tools/chain-status.ts`
- Modify: `packages/mcp/src/daemon-client.ts`
- Modify: `packages/daemon/test/routes/handoffs-status.test.ts`
- Modify: `packages/mcp/test/chain-status.test.ts`

- [ ] **Step 1: Write failing daemon status test**

Add to `packages/daemon/test/routes/handoffs-status.test.ts`:

```ts
test('GET /handoffs/:id/status includes reliability recommendation', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.handoffWriter.create({
    handoff_id: 'h-status-audit',
    ts: '2026-05-01T00:00:00.000Z',
    from: 'user',
    to: 'codex',
    to_role: null,
    message: 'Task type: implement_small\n\nchange it',
    conversation_id: 'c-status-audit',
    project_id: null,
    triggered_by_event_id: 'e-status-audit',
    use_worktree: true,
    chain_task_type: 'implement_small',
  });
  services.handoffWriter.approve('h-status-audit', { resolved_by: 'test', resolved_at: '2026-05-01T00:00:01.000Z' });
  services.handoffWriter.claimDispatch('h-status-audit', 'worker-1');

  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-status-audit/status'), 'h-status-audit', services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.reliability.status).toBeDefined();
  expect(body.reliability.recommended_action).toBeDefined();
});
```

- [ ] **Step 2: Run test to confirm RED**

Run:

```bash
bun test packages/daemon/test/routes/handoffs-status.test.ts
```

Expected: assertion fails because `reliability` is absent.

- [ ] **Step 3: Add reliability summary to handoff status route**

Modify `packages/daemon/src/routes/handoffs.ts` in `handoffsStatusRoute`:

```ts
const events = services.dispatchEventLog.listByHandoff(handoff_id).map((event) => ({
  kind: event.kind,
  ts: event.ts,
  meta: event.meta,
}));
const responses = services.chainReader.getResponses(row.conversation_id, 'final');
const reliability = classifyDispatchReliability({
  handoff: {
    handoff_id: row.handoff_id,
    status: row.status,
    ts: row.ts,
    resolved_at: row.resolved_at,
    cancel_requested_at: row.cancel_requested_at,
    chain_task_type: row.chain_task_type,
    use_worktree: row.use_worktree,
  },
  events,
  responseCount: responses.length,
  finalResponseText: responses.at(-1)?.text ?? null,
  worktreeChanged: null,
  reconciled: null,
  adapterStreaming: null,
  now: services.clock(),
});
```

Add this field to the JSON response:

```ts
reliability: {
  status: reliability.status,
  trustworthy: reliability.trustworthy,
  recommended_action: reliability.recommended_action,
  summary: reliability.summary,
},
```

- [ ] **Step 4: Add MCP status test and implementation**

If `packages/mcp/src/tools/chain-status.ts` proxies the daemon status response, update its test to assert `reliability` is preserved. If it manually maps fields, add:

```ts
reliability: body.reliability ?? null,
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun test packages/daemon/test/routes/handoffs-status.test.ts packages/mcp/test/chain-status.test.ts
bun typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/routes/handoffs.ts packages/mcp/src/tools/chain-status.ts packages/mcp/src/daemon-client.ts packages/daemon/test/routes/handoffs-status.test.ts packages/mcp/test/chain-status.test.ts
git commit -m "feat(agentchat): add reliability guidance to chain status"
```

---

## Task 8: Soak Protocol Note

**Files:**
- Create: `docs/superpowers/notes/2026-05-01-dispatch-reliability-soak.md`

- [ ] **Step 1: Create soak note**

Create `docs/superpowers/notes/2026-05-01-dispatch-reliability-soak.md`:

```md
# Dispatch Reliability Soak

**Start:** 2026-05-01
**Scope:** Penumbra dispatch and delegated agent reliability.

## Daily Checks

- Run `bun packages/agentchat/scripts/reliability-smoke/run.ts`.
- Run `bun typecheck`.
- For every failed or cancelled handoff, run `penumbra dispatch audit <handoff_id> --json`.
- Record any `timeline_inconsistent`, `watchdog_only`, `cancel_completed`, or `agent_declared_done_unverified` result.

## Promotion Policy

- Prefer an agent for a role after 5 task-specific trusted successes.
- Use ranked-first routing after 10 task-specific rows with high trust score.
- Quarantine an agent for a task type after repeated empty output, unverifiable completion, fabricated evidence, or watchdog-only failures.
- Mark environment failures separately from model quality failures.

## Results

| Date | Handoff | Agent | Task type | Reliability status | Action | Notes |
|---|---|---|---|---|---|---|
```

- [ ] **Step 2: Verify note has no placeholders**

Run:

```bash
rg -n "TODO|TBD|placeholder|fill in" docs/superpowers/notes/2026-05-01-dispatch-reliability-soak.md
```

Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-05-01-dispatch-reliability-soak.md
git commit -m "docs: add dispatch reliability soak protocol"
```

---

## Final Verification

Run:

```bash
bun test packages/core/test/services/dispatch-reliability.test.ts
bun test packages/daemon/test/routes/dispatch-audit.test.ts
bun test packages/cli/test/dispatch-audit.test.ts
bun test packages/mcp/test/dispatch-audit.test.ts
bun test packages/agentchat/test/integration/reliability-smoke.test.ts
bun test packages/core/test/writers/agent-performance.test.ts packages/core/test/readers/agent-rank.test.ts
bun test packages/daemon/test/routes/handoffs-status.test.ts packages/mcp/test/chain-status.test.ts
bun typecheck
git diff --check
```

Expected:

- All focused tests pass.
- `bun typecheck` passes.
- `git diff --check` reports no whitespace errors.

## Execution Strategy

Use subagent-driven development by default:

1. Dispatch Task 1 to one worker.
2. Review the diff and run focused tests.
3. Commit if clean.
4. Dispatch Task 2 only after Task 1 lands.
5. Keep Task 5 isolated from routing changes so the smoke harness can stabilize before reliability scores affect routing.

Do not enable routing changes from reliability scores until Tasks 1-6 are green and at least one smoke run has produced expected classifications.
