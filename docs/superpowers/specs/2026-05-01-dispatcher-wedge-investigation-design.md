# Dispatcher wedge investigation — Design

**Status:** spec; investigation-first, no fixes in scope.
**Authors:** Alexandre Cordeiro
**Date:** 2026-05-01

## 1. Goal & scope

Identify and document the root cause(s) of dispatched handoffs that resolve only via the worker watchdog (60 s heartbeat-silence auto-fail), covering both observed shapes:

- **Shape A** — `Bun.spawn`'s `proc.exited` not resolving in `cli-spawn.ts` even after the spawned CLI is effectively dead.
- **Shape B** — Cancel signal observed by the worker but the underlying subprocess is not killed (post-4dc082d residual gaps).

### Deliverables

1. A `dispatch_events` sqlite table + writer + read surface (`penumbra dispatch timeline <handoff_id>` CLI and one MCP tool), wired at the suspect points in `cli-spawn`, the worker dispatcher's cancel path, and the daemon watchdog.
2. A synthetic wedge-probe harness under `packages/agentchat/scripts/wedge-probe/` with fake-CLI shell scripts that provoke each named failure hypothesis, runnable against the real `cli-spawn` adapter.
3. A written RCA at `docs/superpowers/notes/2026-05-01-dispatcher-wedge-rca.md` enumerating each hypothesis, what the harness shows, and which hypothesis (if any) the live evidence corroborates.

### Out of scope (explicit non-goals)

- Shipping fixes for any identified root cause — that is a separate spec.
- Changing the watchdog timeout, heartbeat cadence, or any cancellation timing.
- Touching the streaming `dispatchStream` path beyond reading from it for instrumentation; behavior unchanged.
- Coverage of non-cli-spawn adapters (ACP, openai-compat-http) except where they share the `dispatcher.cancel` path.

### Acceptance criteria — investigation closes when

- Synthetic harness reproduces at least one wedge shape with a complete `dispatch_events` timeline matching the description in the RCA.
- Either: live data shows the same shape against a real CLI within a 1-week soak window, OR the RCA explicitly documents that no live wedge occurred during the soak and ranks the synthetic findings by likelihood.
- Read surface returns the full timeline for any `handoff_id` (no retention pruning during the soak — see Section 2).

## 2. `dispatch_events` schema + write/read surface

### Table (sqlite, daemon-owned)

```sql
CREATE TABLE dispatch_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id   TEXT NOT NULL,
  worker_id    TEXT,                   -- null for purely daemon-side events
  source       TEXT NOT NULL,          -- 'worker' | 'daemon'
  kind         TEXT NOT NULL,          -- closed enum, see below
  ts           TEXT NOT NULL,          -- ISO-8601 ms (matches handoffs.ts convention)
  meta_json    TEXT,                   -- optional small JSON, ≤4 KB
  CHECK (meta_json IS NULL OR length(meta_json) <= 4096)
);
CREATE INDEX idx_dispatch_events_handoff ON dispatch_events(handoff_id, ts);
CREATE INDEX idx_dispatch_events_ts      ON dispatch_events(ts);
```

### Closed `kind` enum (worker-side `[w]`, daemon-side `[d]`)

| Kind | Side | Meta |
|---|---|---|
| `dispatch.start` | w | `{ agent, adapter, prompt_bytes }` |
| `proc.spawn` | w | `{ argv0, pid, has_signal }` |
| `proc.kill.sent` | w | `{ pid, signal: 'SIGTERM' \| 'SIGKILL', reason }` |
| `proc.exited.resolved` | w | `{ pid, code, wall_ms_since_spawn }` |
| `cancel.received` | w | `{ source: 'sse' \| 'reconnect' }` |
| `cancel.dispatched` | w | `{ matched: bool }` |
| `heartbeat.sent` | w | (none) |
| `heartbeat.received` | d | (none) |
| `watchdog.tick` | d | `{ workers_checked, stale_count }` |
| `watchdog.auto_fail` | d | `{ worker_id, ms_since_heartbeat }` |
| `dispatch.end` | w | `{ status: 'ok' \| 'aborted' \| 'error', wall_ms }` |

### Write path

- **Daemon events** (`heartbeat.received`, `watchdog.tick`, `watchdog.auto_fail`) — direct sqlite insert via a new `services.dispatchEventLog` writer, called from the existing watchdog and heartbeat-route handlers.
- **Worker events** — buffered in-memory queue, flushed via fire-and-forget POST to a new `POST /dispatch/events` daemon route (batch payload, max ~50 events per POST). Flushes every 500 ms, on `dispatch.end`, and on worker shutdown. Synchronous POST would add hot-path latency; batched async accepts a small loss window in the case of a worker hard-kill, which we accept (the wedge investigation cares about cases where the worker is *up* and dispatching).

### Read surface

- **HTTP**: `GET /dispatch/events?handoff_id=<id>` returning ordered events; powers both clients below.
- **CLI**: `penumbra dispatch timeline <handoff_id>` — pretty table by default, `--json` for raw.
- **MCP**: `mcp__penumbra__dispatch_timeline({ handoff_id })` returning the array.

### Retention

None during the investigation. After the soak window we either keep a 14-day rolling prune (daemon background tick) or drop the writers and leave the read surface as a no-op — that decision lives in the follow-up RCA, not this spec.

The schema is tightly bounded on purpose: closed `kind` enum (no free-form strings), 4 KB meta cap, `(handoff_id, ts)` indexed. Easy to migrate away from later.

## 3. Instrumentation points

Each writer call cites the file:line from the code map. All worker calls go through the buffered queue described in Section 2; all daemon calls write directly via the new service.

### Worker — `cli-spawn` adapter (`packages/agentchat/src/adapters/cli-spawn.ts`)

| Event | Where | Meta payload |
|---|---|---|
| `proc.spawn` | After `Bun.spawn(...)` returns at lines 77-83 (streaming) and 181-187 (buffered) | `{ argv0: argv[0], pid: proc.pid, has_signal: !!opts.signal }` |
| `proc.kill.sent` | Inside the `onAbort` listener at lines 88-97, **once per `proc.kill()` call** (so SIGTERM and the deferred SIGKILL both record) | `{ pid, signal, reason: 'abort' }` |
| `proc.exited.resolved` | Immediately after `await proc.exited` at line 142 resolves | `{ pid, code, wall_ms_since_spawn }` |

### Worker — dispatcher cancel path (`packages/agentchat/src/worker/`)

| Event | Where | Meta |
|---|---|---|
| `dispatch.start` | `dispatcher.ts` `handleOne()` after `AbortController` creation (line 76) | `{ agent, adapter, prompt_bytes }` |
| `cancel.received` | `control-listener.ts:65-69` SSE `cancel` branch | `{ source: 'sse' }` |
| `cancel.dispatched` | `dispatcher.ts:245-259` `cancel()` method, after the entry-match check | `{ matched }` |
| `dispatch.end` | `handleOne()` finally block (after `proc.exited` collected, before status write) | `{ status, wall_ms }` |

### Worker — heartbeat emitter (location TBD)

Explore agent flagged `bin/agentchat-worker.ts` but couldn't pin the timer. Implementer must locate it; if the worker doesn't emit heartbeats on a timer (only inline somewhere), the RCA records that as a wedge contributor.

| Event | Where | Meta |
|---|---|---|
| `heartbeat.sent` | At the worker-side POST to `/worker/heartbeat`, immediately after the request resolves (success or fail) | (none) |

### Daemon — heartbeat route (`packages/daemon/src/routes/worker-heartbeat.ts:29`)

| Event | Where | Meta |
|---|---|---|
| `heartbeat.received` | After `services.watchdog.recordHeartbeat(worker_id)` returns. Per-worker, not per-handoff. Stored with `handoff_id = ''` (sentinel); the dispatch-timeline reader stitches by `worker_id + ts` window at read time. The alternative (joining at write time by looking up the worker's active handoff) couples writers to mutable worker state. | (none) |

### Daemon — watchdog (`packages/daemon/src/services/watchdog.ts`)

| Event | Where | Meta |
|---|---|---|
| `watchdog.tick` | Top of `tick()` at line 20 | `{ workers_checked, stale_count }` |
| `watchdog.auto_fail` | After `services.handoffWriter.markFailed()` at line 46, **per handoff transitioned** | `{ worker_id, ms_since_heartbeat }` |

### Primary signal we are hunting

If Shape A is real, we will see `proc.spawn` + (optionally) `proc.kill.sent` for that handoff, but **no `proc.exited.resolved`** before the `watchdog.auto_fail`. That gap-pattern is the diagnostic. Conversely, if `proc.exited.resolved` *does* fire but `dispatch.end` never does, the bug is downstream of the spawn helper.

## 4. Synthetic wedge-probe harness

Lives at `packages/agentchat/scripts/wedge-probe/`. Each fake CLI is a shell script that exhibits one named hypothesis, run through the **real** `cli-spawn` helper (no mocks) so the timeline written to `dispatch_events` is the real instrumentation under test.

### Probes

| ID | File | Behavior | Hypothesis tested |
|---|---|---|---|
| **A** | `probes/wedge-A-sigterm-deaf.sh` | `trap '' TERM; sleep 600` | SIGTERM-deaf subprocess; verifies SIGKILL grace fires and `proc.exited` resolves with code 137 |
| **B** | `probes/wedge-B-detach-stdio.sh` | `bash -c '(sleep 600 &) ; echo done'` — parent exits, child inherits + holds stdout/stderr fds | **Prime Shape A hypothesis**: orphan child keeps the pipe open so `await proc.exited` hangs even though the spawned PID is gone |
| **C** | `probes/wedge-C-stdout-backpressure.sh` | `yes hello \| head -c 100000000 ; exit 0` (100 MB stdout) | Back-pressure: does a slow stdout consumer block `proc.exited`? |
| **D** | `probes/wedge-D-baseline.sh` | `echo started ; sleep 3600` | Healthy baseline: aborts cleanly via SIGTERM, used as control |

### Runner (`packages/agentchat/scripts/wedge-probe/run-probes.ts`)

- Iterates probes, calls `spawnCliAdapter` / `spawnCliAdapterStream` directly with a fresh `AbortController` per probe.
- Aborts after a probe-specific delay (default 3 s; baseline only).
- Wraps each probe in its own hard timeout (default 30 s wall) — if the runner itself wedges, that *is* the result we want to see, just bounded so the harness doesn't hang CI/dev.
- After each probe, queries `GET /dispatch/events?handoff_id=probe-<X>-<run_ts>` and prints the timeline as a table. Exit code 0 if every probe produced a complete event sequence ending in `proc.exited.resolved`; non-zero (with the hung probe id) otherwise.

### Correlation plumbing — the one production-code touch the harness requires

The `cli-spawn` writers need to know which `handoff_id` to tag events with. Today the spawn helper has no concept of one. We add an optional field to `SpawnOpts`:

```ts
interface SpawnOpts {
  // ... existing ...
  eventContext?: { handoffId: string; workerId?: string };
}
```

If absent, **no events are emitted** (zero behavior change for any caller that doesn't opt in). The worker dispatcher passes it from the active handoff. The probe runner passes synthetic `probe-A-1714...`, etc. This keeps the writer call sites trivially testable and means the eventual fix can be evaluated by re-running the harness without depending on the worker.

### Why these four

B is the load-bearing one — the cleanest synthetic recreation of the real-world wedge pattern (long-running CLIs that fork helpers). A and C are the most plausible secondary causes given Bun's pipe handling. D is a control: if D fails, instrumentation or the SIGTERM path itself is broken and the others are moot.

### Not included

Probes against real CLIs (gemini, claude, codex, opencode). Those are too quota-expensive to run on every harness invocation; the live soak window from Section 1 covers that side.

## 5. RCA process & acceptance gate

### RCA document — `docs/superpowers/notes/2026-05-01-dispatcher-wedge-rca.md`

Section structure (concrete so the writer doesn't have to invent it):

1. **Failure shapes** — the two from Section 1, restated with any refinements learned.
2. **Hypothesis table** — one row per named hypothesis (orphan-stdio child, SIGTERM-deaf, stdout backpressure, signal-listener race, control-listener reconnect drop, SSE keepalive miss, etc.), with columns: source-of-belief, probe id (if synthetic), live-evidence handoff_ids (if any), verdict (`confirmed` / `refuted` / `inconclusive`), notes.
3. **Synthetic probe results** — paste the runner's table output for each probe + the timeline it produced.
4. **Live evidence** — for any handoff that wedged during the soak, the full `dispatch_events` timeline (verbatim) plus a one-line interpretation. If zero live wedges, state that explicitly with the soak window's wall-clock dispatch count as denominator.
5. **Conclusion** — single paragraph naming the root cause(s) and confidence level (`high`, `medium`, `low`). If multiple causes are co-implicated, rank them.
6. **Recommended fixes** — bullet list, each item one line: what to change, where (file:line), and the hypothesis it addresses. **No code in this doc** — input to the follow-up plan, not the plan.

### Soak window protocol

- Day 0: instrumentation merged + `dispatch_events` populated for all real dispatches.
- Day 0: probe harness run end-to-end; results captured.
- Days 1–7: passive observation. The maestro doesn't need to do anything special; just dispatch as usual. Any wedge that occurs is captured in `dispatch_events` automatically.
- Day 7 (or earlier if a wedge produces conclusive live evidence): RCA written from the data we have, even if no live wedge fired.

### Acceptance gate (final)

1. `bun test` clean for the new packages (event writer, route, CLI command, MCP tool).
2. `penumbra dispatch timeline <handoff_id>` returns a non-empty timeline for at least one real dispatch executed after merge.
3. Probe runner exits 0 for D (baseline) and produces a complete timeline (success or wedge-detected) for A, B, C.
4. RCA document committed with all six sections populated; the hypothesis table has at least one `confirmed` or `refuted` verdict per hypothesis listed (no rows left as `inconclusive` without an explicit reason in `notes`).
5. Investigation closes when the RCA is committed, regardless of whether a fix is identified — the deliverable is the diagnosis, not the cure.

### Explicit non-gate

A wedge does not have to occur during the soak. If the system runs cleanly for a week, that is itself a finding (and the conclusion section reflects that ranking).

## 6. Risks, open questions, & non-goals (recap)

### Risks

1. **Wire chatter from `dispatch_events` perturbs the system we're observing.** A dispatch emitting 8–12 events with a 500 ms-batched POST is not free, and a sufficiently slow daemon could bottleneck the worker. **Mitigation:** fire-and-forget POST (worker never awaits the response); bounded queue (drop oldest with a `events.dropped` counter beyond 1000 in-flight); benchmark POST latency against current heartbeat-route latency before merge.

2. **The orphan-stdio hypothesis (probe B) might not reproduce inside `bun test`** because Bun's test runner inherits a controlled process group and may collect zombies differently than the launchd-spawned worker. **Mitigation:** the harness runs as a standalone `bun packages/agentchat/scripts/wedge-probe/run-probes.ts` script, not inside `bun test`. Document the difference if behavior diverges.

3. **Soak window may produce zero live wedges.** Recent fixes (4dc082d, 866a073) might have actually closed the production hole; the wedges we observed were pre-fix. **Mitigation:** explicitly accepted in Section 5's acceptance gate — zero live wedges is itself a finding, ranked against the synthetic results.

4. **Adding `eventContext` to `SpawnOpts` touches a hot helper.** Risk of breaking existing callers if optionality is mishandled. **Mitigation:** strictly optional, defaults to `undefined`, all behavior gated on `if (opts.eventContext)`. New tests in `cli-spawn.test.ts` verify zero-event behavior when omitted.

5. **The watchdog timeout (60 s) and SIGKILL grace (`PENUMBRA_CANCEL_GRACE_S`) are not changed.** If the investigation reveals a wedge that resolves cleanly at, say, 90 s — i.e. the watchdog fires too early — that's a finding the RCA names but does not act on. The fix is a separate spec.

### Open questions (deferred to implementation, flagged here)

1. **Heartbeat emitter location** — Explore agent didn't pin the worker-side timer. Implementer must locate it before wiring `heartbeat.sent`. If the worker doesn't emit heartbeats on a timer (only inline somewhere), the RCA records that as a wedge contributor.

2. **Whether `proc.kill.sent` should fire from the SIGKILL branch when the SIGTERM grace expires but `proc.exited` already resolved.** The straightforward path (always fire on every `proc.kill()` invocation) over-counts but never under-counts; we accept the over-count.

3. **MCP tool name** — `mcp__penumbra__dispatch_timeline` follows existing naming, but the user may prefer a verb like `mcp__penumbra__dispatch_events_get`. Trivial to flip; deferring to convention check during implementation.

### Non-goals (recap)

- No fix for any identified root cause.
- No watchdog/heartbeat/grace timing changes.
- No instrumentation of non-cli-spawn adapters except `dispatcher.cancel` itself (which is shared).
- No retention/pruning until after the RCA closes.
