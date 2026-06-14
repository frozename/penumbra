---
plan_id: 2026-05-26-worker-wedge-recovery
home_project: penumbra
plan_defaults:
  bounds:
    wall_clock_ms: 900000
    cost_cents: 50
    max_sub_dispatches: 3
---

# Worker Wedge Recovery + Event-Queue Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop supervised workers from staying wedged for arbitrarily long. Wedge detection should actually restart the wedged process, and the worker's outbound HTTP calls should not deadlock the event queue when the daemon stalls.

**Architecture:** Two independent fixes in one plan. Fix B (HTTP timeouts) is the lower-level guard — it ensures `event-queue.flush()` and `penumbra-client.post()` can't sit on a hung fetch forever, which was the visible symptom (14 events flushed at one millisecond after a 17-minute wedge). Fix A (wedge-eviction → supervisor restart) is the recovery loop — once the probe declares a worker wedged, the supervisor should `restartWorker` it instead of just logging the event.

**Tech Stack:** TypeScript, Bun, Bun.spawn child processes, `bun:test`.

**Evidence:** `docs/notes/maestro-continuation-2026-05-26-pm-late.md` plus forensic dispatch_events query in the originating maestro session — heartbeat gap 2026-05-26 15:09:24 → 15:10:59 for `shared-1`, followed by `extra_worker_wedge_evicted` at 15:26:47 and a 14-event burst at the exact same millisecond (15:27:20.392), proving the event queue had been deadlocked the entire time.

## Phase 1: HTTP timeouts (defense against hung fetch)

Dispatch graph: 1.1 → 1.2 → 1.3

### Task 1.1: Add a timeout to `DispatchEventQueue.flush`

```yaml meta
id: 1.1
files:
  - packages/agentchat/src/worker/event-queue.ts
  - packages/agentchat/test/worker/event-queue.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `packages/agentchat/src/worker/event-queue.ts`
- Modify: `packages/agentchat/test/worker/event-queue.test.ts`

**Context:** `flush()` awaits `this.send(batch)` with no timeout (line 54). If the underlying POST hangs, `flushing` stays `true` forever; every subsequent `enqueue` just buffers without ever sending. Verified in production on 2026-05-26: 17-minute wedge ended in a 14-event burst at the same millisecond when the hang resolved.

- [ ] **Step 1: Write the failing test**

Add to `packages/agentchat/test/worker/event-queue.test.ts` (inside the same `describe('DispatchEventQueue', () => { ... })` block):

```text
  test('flush rejects-and-recovers when send hangs beyond send_timeout_ms', async () => {
    let unblock!: () => void;
    let hangCount = 0;
    const send = mock((_events: DispatchEventInput[]) => {
      hangCount++;
      if (hangCount === 1) {
        return new Promise<void>((resolve) => {
          unblock = resolve;
        });
      }
      return Promise.resolve();
    });
    const queue = new DispatchEventQueue({
      send,
      flushIntervalMs: 10_000,
      maxBatch: 50,
      maxQueue: 10,
      sendTimeoutMs: 30,
    });

    queue.enqueue(sample);
    // First flush will hang on the send promise; the timeout must abort it so
    // flushing=false is cleared and a second flush can run.
    await queue.flush();
    // Second enqueue + flush must NOT block on the first send still being in-flight.
    queue.enqueue({ ...sample, kind: 'proc.spawn' });
    await queue.flush();

    expect(send).toHaveBeenCalledTimes(2);
    // Release the first (still-pending) promise so node doesn't complain on shutdown.
    unblock();
    await queue.stop();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agentchat/test/worker/event-queue.test.ts -t "flush rejects-and-recovers"`
Expected: TypeScript error on `sendTimeoutMs` (option does not exist), OR the test hangs / times out at the test runner's default (currently it would deadlock on the first `await queue.flush()`).

- [ ] **Step 3: Implement the timeout**

Modify `packages/agentchat/src/worker/event-queue.ts`:

```text
export interface DispatchEventQueueOpts {
  send: (events: DispatchEventInput[]) => Promise<void>;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  /** Max time to wait per send() call before declaring it stuck and freeing the flush gate. Default 10_000. */
  sendTimeoutMs?: number;
}

export class DispatchEventQueue {
  private buffer: DispatchEventInput[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private readonly send: (events: DispatchEventInput[]) => Promise<void>;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly sendTimeoutMs: number;

  constructor(opts: DispatchEventQueueOpts) {
    this.send = opts.send;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxQueue = opts.maxQueue ?? 1000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 10_000;
    this.timer = setInterval(() => {
      void this.flush();
    }, opts.flushIntervalMs ?? 500);
  }
```

And inside `flush()`'s inner async IIFE, replace the bare `await this.send(batch)` with a race that frees the gate even if `send` is still pending:

```text
        while (this.buffer.length > 0) {
          const batch = this.buffer.splice(0, this.maxBatch);
          try {
            await Promise.race([
              this.send(batch),
              new Promise<void>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`event_queue_send_timeout_${this.sendTimeoutMs}ms`)),
                  this.sendTimeoutMs,
                ),
              ),
            ]);
          } catch {
            // Drop failed or timed-out instrumentation batches; do not let one stuck call hold the gate.
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/agentchat/test/worker/event-queue.test.ts`
Expected: all tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/event-queue.ts packages/agentchat/test/worker/event-queue.test.ts
git commit <<'EOF'
fix(agentchat): event-queue flush timeout prevents deadlock

A hung send() on /dispatch/events left flushing=true forever, holding
queued heartbeat.sent / dispatch.* events for as long as the underlying
POST stayed pending. Wrap each send in a 10s race; on timeout drop the
batch and release the flush gate so subsequent ticks can drain the
buffer.
EOF
```

### Task 1.2: Add a fetch timeout to `PenumbraClient.post`

```yaml meta
id: 1.2
files:
  - packages/agentchat/src/penumbra-client.ts
  - packages/agentchat/test/penumbra-client.test.ts
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `packages/agentchat/src/penumbra-client.ts:467-488`
- Modify: `packages/agentchat/test/penumbra-client.test.ts`

**Context:** `post`, `postWorker`, `postWorkerNoContent`, and `get` all call `this.fetcher(...)` with no `AbortSignal` and no timeout. A stalled daemon hangs the call indefinitely. Apply a per-call timeout; preserve the existing `withWorkerTokenRetry` (401-reregister) semantics on `postWorker`/`postWorkerNoContent`.

- [ ] **Step 1: Write the failing test**

Add to `packages/agentchat/test/penumbra-client.test.ts` (use the existing patterns in that file — instantiate `PenumbraClient` with an injected `fetch`):

```text
test('post rejects with timeout error when fetch hangs', async () => {
  const hangFetch = mock((..._args: Parameters<typeof fetch>): Promise<Response> =>
    new Promise(() => { /* never resolves */ }),
  );
  const client = new PenumbraClient({
    storageRoot: makeStorageRoot(),
    fetch: hangFetch as unknown as typeof fetch,
    requestTimeoutMs: 30,
  });

  await expect(client.observe({ kind: 'unit-test' })).rejects.toThrow(/timeout/i);
});
```

If `makeStorageRoot` doesn't exist yet in that test file, look for the existing helper that other tests use to set up port/token files in a tmp dir; reuse it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agentchat/test/penumbra-client.test.ts -t "post rejects with timeout"`
Expected: TypeScript error on `requestTimeoutMs`, or the test runner times out at its own default.

- [ ] **Step 3: Implement the timeout**

Modify `packages/agentchat/src/penumbra-client.ts`. Add to the options type:

```text
export interface PenumbraClientOpts {
  storageRoot?: string;
  fetch?: typeof fetch;
  logger?: PenumbraClientLogger;
  /** Per-request fetch timeout in ms. Default 30_000. */
  requestTimeoutMs?: number;
}
```

Store it in the constructor (alongside `this.fetcher`):

```text
  private readonly requestTimeoutMs: number;
  // ...
  constructor(opts: PenumbraClientOpts = {}) {
    this.storageRoot = opts.storageRoot;
    this.fetcher = opts.fetch ?? fetch;
    this.logger = opts.logger ?? null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }
```

Add a small helper above `post`:

```text
  private fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const ac = new AbortController();
    const upstream = (init as { signal?: AbortSignal }).signal;
    if (upstream) {
      if (upstream.aborted) ac.abort(upstream.reason);
      else upstream.addEventListener('abort', () => ac.abort(upstream.reason), { once: true });
    }
    const timer = setTimeout(
      () => ac.abort(new Error(`penumbra_client_request_timeout_${this.requestTimeoutMs}ms`)),
      this.requestTimeoutMs,
    );
    return this.fetcher(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
  }
```

Then replace `this.fetcher(...)` with `this.fetchWithTimeout(...)` in **`post`, `postWorker`, `postWorkerNoContent`, and `get`** only. Leave `subscribeSse` alone — SSE streams are long-lived by design and have their own AbortSignal threading.

- [ ] **Step 4: Run all client tests**

Run: `bun test packages/agentchat/test/penumbra-client.test.ts`
Expected: all tests pass; the new timeout test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/penumbra-client.ts packages/agentchat/test/penumbra-client.test.ts
git commit <<'EOF'
fix(agentchat): per-request timeout on PenumbraClient HTTP calls

Workers blocked indefinitely when daemon fetch responses stalled (no
timeout on the underlying fetch). Add a 30s default per-call timeout
plumbed through an internal AbortController; subscribeSse remains
exempt since SSE streams are intentionally long-lived.
EOF
```

### Task 1.3: Verify nothing else regresses

```yaml meta
id: 1.3
files:
  - packages/agentchat
file_scope: modify-existing
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Verify: `packages/agentchat/**`

- [ ] **Step 1: Run the agentchat package tests**

Run: `bun test packages/agentchat`
Expected: all green, no new failures introduced by the timeout changes.

- [ ] **Step 2: Run the daemon package tests (cross-package consumers)**

Run: `bun test packages/daemon`
Expected: all green. If any test that mocks `PenumbraClient` breaks due to new option, accept default and confirm timeouts don't fire under test-default conditions.

Integration: This phase lands as two commits on the agent branch. Cherry-pick onto `main` only after Phase 2 lands so the wedge-recovery fix and its timeout backstop ship together.


## Phase 2: Wedge eviction restarts the wedged worker

Dispatch graph: 2.1 → 2.2 → 2.3 → 2.4

### Task 2.1: Expose `restartWorkerById` on the supervisor

```yaml meta
id: 2.1
files:
  - packages/daemon/src/workers/supervisor.ts
  - packages/daemon/test/workers/supervisor.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `packages/daemon/src/workers/supervisor.ts:219-231` (existing private `restartWorker`)
- Modify or create: `packages/daemon/test/workers/supervisor.test.ts`

**Context:** `ExtraWorkerSupervisor.restartWorker(extra: ExtraWorkerConfig)` is private and takes a full config object. Callers (specifically the health probe) only know a `worker_id` string. Add a public `restartWorkerById(workerId: string): Promise<boolean>` that looks the worker up in `this.extras` and reuses the existing restart path. Return `false` (no throw) when the id is unknown — the probe should not crash if a worker was removed mid-flight.

- [ ] **Step 1: Find an existing supervisor test or create one**

Run: `ls packages/daemon/test/workers/`
If `supervisor.test.ts` exists, read it to understand the spawn-mock fixture. Otherwise create a new file using the spawn-injection pattern: `new ExtraWorkerSupervisor({ ... spawn: fakeSpawn ... })`.

- [ ] **Step 2: Write the failing test**

Append to (or create) `packages/daemon/test/workers/supervisor.test.ts`:

```text
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ExtraWorkerSupervisor } from '../../src/workers/supervisor.js';
import type { ExtraWorkerConfig } from '../../src/workers/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, tmpdir } from 'node:path';
import { tmpdir as osTmp } from 'node:os';

const baseExtra = (id: string): ExtraWorkerConfig => ({
  id,
  concurrency: 1,
  project_id: null,
  isolation: 'shared',
});

const noopLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
};

const fakeSpawn = () => {
  const exited = new Promise<{ code: number; signal?: string }>(() => {});
  return {
    pid: Math.floor(Math.random() * 100_000),
    exitCode: null,
    signalCode: null,
    stdout: null,
    stderr: null,
    exited,
    kill: () => {},
  };
};

test('restartWorkerById returns false for unknown worker_id', async () => {
  const root = mkdtempSync(join(osTmp(), 'sup-'));
  const sup = new ExtraWorkerSupervisor({
    extras: [baseExtra('alpha')],
    storageRoot: root,
    log: noopLog as any,
    spawn: fakeSpawn as any,
  });
  await sup.start();
  const result = await sup.restartWorkerById('does-not-exist');
  expect(result).toBe(false);
  await sup.stop();
  rmSync(root, { recursive: true, force: true });
});

test('restartWorkerById spawns a replacement process for a known worker', async () => {
  const root = mkdtempSync(join(osTmp(), 'sup-'));
  const spawnCalls: number[] = [];
  const spawn = () => { spawnCalls.push(Date.now()); return fakeSpawn(); };
  const sup = new ExtraWorkerSupervisor({
    extras: [baseExtra('alpha')],
    storageRoot: root,
    log: noopLog as any,
    spawn: spawn as any,
  });
  await sup.start();
  expect(spawnCalls).toHaveLength(1);
  const ok = await sup.restartWorkerById('alpha');
  expect(ok).toBe(true);
  expect(spawnCalls).toHaveLength(2);
  await sup.stop();
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/daemon/test/workers/supervisor.test.ts`
Expected: TypeScript error — `restartWorkerById` does not exist on `ExtraWorkerSupervisor`.

- [ ] **Step 4: Add the public method**

Insert into `packages/daemon/src/workers/supervisor.ts`, right after the existing private `restartWorker`:

```text
  /**
   * Public form keyed by worker_id — looks the worker config up in this.extras
   * and runs the existing restart path. Returns false (no throw) when the id
   * is unknown so callers (e.g. the wedge-recovery signal handler) can no-op
   * safely if a worker was removed mid-flight.
   */
  public async restartWorkerById(workerId: string): Promise<boolean> {
    if (this.stopped) return false;
    const next = this.extras.find((extra) => extra.id === workerId);
    if (!next) return false;
    await this.restartWorker(next);
    return true;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/daemon/test/workers/supervisor.test.ts`
Expected: both new tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/workers/supervisor.ts packages/daemon/test/workers/supervisor.test.ts
git commit <<'EOF'
feat(daemon): expose ExtraWorkerSupervisor.restartWorkerById

Public id-keyed entrypoint for callers that only know the worker_id
string (the wedge-recovery signal handler in particular). Returns
false on unknown id so the caller can no-op safely.
EOF
```

### Task 2.2: Wire the controller to call `restartWorkerById`

```yaml meta
id: 2.2
files:
  - packages/daemon/src/services/worker-health-probe.ts
  - packages/daemon/test/services/worker-health-probe.test.ts
file_scope: modify-existing
depends_on: ['2.1']
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `packages/daemon/src/services/worker-health-probe.ts:147-197`
- Modify: `packages/daemon/test/services/worker-health-probe.test.ts`

**Context:** `createWorkerHealthController` records the `extra_worker_wedge_evicted` event and runs orphan recovery, but does NOT replace the wedged process. Add a `supervisor` dep with `restartWorkerById` and call it after orphan recovery completes. Restart is best-effort — failure to restart must not throw out of `onSignal` (the probe owns the signal contract).

- [ ] **Step 1: Extend the controller test**

Modify `packages/daemon/test/services/worker-health-probe.test.ts` — find the test(s) that exercise `createWorkerHealthController` directly (or add one if the file only tests the probe). Use this fixture:

```text
const makeController = () => {
  const dispatchEventLog = { record: mock(() => {}) };
  const orphanHandoffRecovery = {
    recoverForWorker: mock(() => ({
      requeued: 0, exhausted: 0, exhaustedRowIds: [], requeuedRowIds: [],
      _exhaustedRows: [], _requeuedRows: [],
    })),
  };
  const supervisor = { restartWorkerById: mock(async (_id: string) => true) };
  const ctrl = createWorkerHealthController({ dispatchEventLog, orphanHandoffRecovery, supervisor });
  return { ctrl, dispatchEventLog, orphanHandoffRecovery, supervisor };
};

test('controller restarts wedged worker on miss_threshold_exceeded', async () => {
  const { ctrl, supervisor, dispatchEventLog } = makeController();
  ctrl.onSignal({
    kind: 'miss_threshold_exceeded',
    worker_id: 'shared-1',
    probe_id: 'p-1',
    misses: 3,
    probe_interval_ms: 15_000,
  });
  // controller returns synchronously but kicks off the restart promise; await one tick.
  await Promise.resolve(); await Promise.resolve();
  expect(dispatchEventLog.record).toHaveBeenCalledTimes(1);
  expect(supervisor.restartWorkerById).toHaveBeenCalledWith('shared-1');
});

test('controller swallows supervisor restart errors', async () => {
  const { ctrl, supervisor } = makeController();
  supervisor.restartWorkerById = mock(async () => { throw new Error('boom'); });
  expect(() => ctrl.onSignal({
    kind: 'miss_threshold_exceeded',
    worker_id: 'shared-1',
    probe_id: 'p-2',
    misses: 3,
    probe_interval_ms: 15_000,
  })).not.toThrow();
});
```

`mock` is already imported in that file (via `bun:test` `vi`). If `mock` isn't in scope, add `import { mock } from 'bun:test'` or use `vi.fn()` to match the existing style.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/daemon/test/services/worker-health-probe.test.ts -t "restart"`
Expected: TypeScript errors — `supervisor` not in `WorkerHealthControllerDeps`; `createWorkerHealthController` does not call `restartWorkerById`.

- [ ] **Step 3: Add supervisor to the deps interface**

Modify `packages/daemon/src/services/worker-health-probe.ts`:

```text
export interface WorkerHealthControllerDeps {
  dispatchEventLog: {
    record(event: {
      handoff_id: string;
      worker_id: string;
      source: 'daemon';
      kind: 'extra_worker_wedge_evicted';
      ts: string;
      meta: {
        worker_id: string;
        probe_id: string;
        misses: number;
        probe_interval_ms: number;
        event: 'probe_timeout';
      };
    }): void;
  };
  orphanHandoffRecovery: {
    recoverForWorker(workerId: string): {
      requeued: number;
      exhausted: number;
      exhaustedRowIds: string[];
      requeuedRowIds: string[];
      _exhaustedRows: unknown[];
      _requeuedRows: unknown[];
    };
  };
  supervisor: {
    restartWorkerById(workerId: string): Promise<boolean>;
  };
}
```

And inside `createWorkerHealthController`, after the existing dispatchEventLog/orphanHandoffRecovery calls, kick off the restart without awaiting (the contract is one synchronous signal per miss streak — restart must not block other workers' probe processing):

```text
export function createWorkerHealthController(services: WorkerHealthControllerDeps): WorkerHealthController {
  return {
    onSignal: (signal) => {
      const dispatchEvent = {
        handoff_id: ,
        worker_id: signal.worker_id,
        source: 'daemon',
        kind: 'extra_worker_wedge_evicted',
        ts: new Date().toISOString(),
        meta: {
          worker_id: signal.worker_id,
          probe_id: signal.probe_id,
          misses: signal.misses,
          probe_interval_ms: signal.probe_interval_ms,
          event: 'probe_timeout',
        },
      };
      services.dispatchEventLog.record(dispatchEvent);
      services.orphanHandoffRecovery.recoverForWorker(signal.worker_id);
      void services.supervisor
        .restartWorkerById(signal.worker_id)
        .catch(() => {
          // Restart is best-effort; the wedge has already been recorded and
          // orphans recovered. A failed restart will be retried by the next
          // miss-streak signal.
        });
    },
  };
}
```

- [ ] **Step 4: Update call sites in `serve.ts` that wire the controller**

Run: `grep -n "createWorkerHealthController" packages/daemon/src/serve.ts`
Find the wiring (likely in `serve.ts` near supervisor construction) and pass `supervisor: opts.services.supervisor` (or whatever the local binding is) into the controller deps. If the supervisor isn't yet in scope at that point, hoist its construction earlier so it's available.

- [ ] **Step 5: Run probe + serve tests**

Run: `bun test packages/daemon/test/services/worker-health-probe.test.ts`
Run: `bun test packages/daemon` (catch anything in serve-wiring tests)
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/services/worker-health-probe.ts packages/daemon/src/serve.ts packages/daemon/test/services/worker-health-probe.test.ts
git commit <<'EOF'
fix(daemon): wedge eviction restarts the wedged worker

Previously the WorkerHealthController only recorded
extra_worker_wedge_evicted and ran orphan recovery — the wedged
process kept running unresponsive until the next config reload or
daemon restart. Wire the controller to call
supervisor.restartWorkerById so wedge detection produces actual
recovery. Restart is best-effort: failures are swallowed because the
next miss streak will retry.
EOF
```

### Task 2.3: End-to-end probe → restart smoke

```yaml meta
id: 2.3
files:
  - packages/daemon/test/services/worker-health-probe.test.ts
file_scope: modify-existing
depends_on: ['2.2']
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `packages/daemon/test/services/worker-health-probe.test.ts`

**Context:** Round-trip test: `WorkerHealthProbe` with `missThreshold: 3` and a `setSystemTime`-driven clock; after three ticks with no `recordAck`, the controller wired with a fake supervisor must have called `restartWorkerById` exactly once for that streak.

- [ ] **Step 1: Write the integration test**

Append to `packages/daemon/test/services/worker-health-probe.test.ts`:

```text
test('probe miss threshold triggers exactly one restart per streak', async () => {
  const restartCalls: string[] = [];
  const supervisor = { restartWorkerById: mock(async (id: string) => { restartCalls.push(id); return true; }) };
  const dispatchEventLog = { record: mock(() => {}) };
  const orphanHandoffRecovery = {
    recoverForWorker: mock(() => ({
      requeued: 0, exhausted: 0, exhaustedRowIds: [], requeuedRowIds: [],
      _exhaustedRows: [], _requeuedRows: [],
    })),
  };
  const controller = createWorkerHealthController({ dispatchEventLog, orphanHandoffRecovery, supervisor });

  let now = new Date('2026-05-26T15:00:00.000Z').getTime();
  const fixture = buildServices({ workerIds: ['wedged-1'], clock: () => new Date(now) });

  const probe = new WorkerHealthProbe({
    services: fixture.services as any,
    intervalMs: 1_000,
    missThreshold: 3,
    log: fixture.services.log as any,
    controller,
  });
  // Drive three ticks past the miss deadline without recording an ack.
  for (let i = 0; i < 4; i++) {
    await (probe as any).tick();
    now += 3_000;
  }
  // Allow microtask queue to settle for the void-kicked supervisor.restartWorkerById call.
  await Promise.resolve(); await Promise.resolve();
  expect(restartCalls).toEqual(['wedged-1']);
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/daemon/test/services/worker-health-probe.test.ts -t "exactly one restart per streak"`
Expected: PASS. If it fails because `tick()` is not exposed, either expose it for tests via a named export or drive via `start()` + mock setInterval (the existing test file's pattern dictates which).

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/test/services/worker-health-probe.test.ts
git commit <<'EOF'
test(daemon): probe-to-restart end-to-end miss-streak smoke

Drive three miss ticks without an ack and assert exactly one
supervisor.restartWorkerById call. Guards the wedge-recovery
contract against future regressions in the controller wiring.
EOF
```

### Task 2.4: Full package test sweep + smoke

```yaml meta
id: 2.4
files:
  - packages/daemon
  - packages/agentchat
file_scope: modify-existing
depends_on: ['2.3', '1.3']
parallel_with: []
preferred_agent: codex-acp-deep
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Files:**
- Verify: `packages/daemon/**`, `packages/agentchat/**`

- [ ] **Step 1: Full test runs**

Run: `bun test packages/daemon packages/agentchat`
Expected: all green.

- [ ] **Step 2: Type-check the whole monorepo**

Run: `bun run typecheck`
Expected: no errors. If `tsc --noEmit` is the underlying command, accept that.

- [ ] **Step 3: No new commit needed unless previous tasks left something uncommitted.**

If git status shows pending changes, investigate before committing — the prior tasks should have committed cleanly.

Integration: cherry-pick or fast-forward-merge the agent branch into `main` after both phases land. Operator verification: kickstart the daemon (`launchctl kickstart -k gui/$UID/dev.penumbra.daemon`), confirm workers come up and heartbeat, then provoke a wedge by sending `SIGSTOP` to a supervised worker for 60s; expect `extra_worker_wedge_evicted` followed by a successful restart event in `~/.penumbra/launchd.daemon.out.log` within ~45s.


## Out of scope (deliberately)

- The duplicate `heartbeat.received` pattern (two events per heartbeat at the same ms in dispatch_events). Forensic curiosity, not on the failure path. File a separate note if it persists after these fixes.
- Tightening the routing-gate window (`PENUMBRA_WORKER_HEARTBEAT_TIMEOUT_MS`) vs. heartbeat cadence — these fixes should close the gap; if 503s persist after deployment, revisit the gate width.
- Removing or fixing the legacy `dev.penumbra.worker` launchctl job — covered by a separate handoff thread.
