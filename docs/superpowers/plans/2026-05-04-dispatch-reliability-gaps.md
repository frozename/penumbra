# Dispatch Reliability Gaps — Implementation Plan

Date: 2026-05-04
Spec: `docs/superpowers/specs/2026-05-04-dispatch-reliability-gaps-design.md`
Status: Ready

## Pre-flight

- Tests: `import { expect, test } from 'bun:test';` Real sqlite via `loadSqliteVec` + `migrate`. `TestEmbedder` from `@penumbra/core/testing`.
- Phase 1 (filter) is independent — ship first to stop the live noise visible right now.
- Phase 4 (sweeper) needs one daemon restart at the end. Phases 1–3 don't.
- Problem 5 from the spec (memory recall empty state) is intentionally out of scope.

## Dispatch graph

```
1.1 → 1.2 → 1.3            (schema → hook command filter → playbook update)
2.1 → 2.2                  (classifier status + capture → worker retry trigger)
3.1                        (single combined task — chain_cancel writes takeover flag)
4.1 → 4.2                  (sweeper module → daemon boot wiring)
```

Phases 1, 2, 3 are independent and can ship in any order. Phase 4 depends only on its own pieces. Sequential execution recommended for traceability.

## Phase 1 — Lifecycle trigger filter

### Task 1.1 — `filter` field on lifecycle trigger schema

```yaml meta
id: '1.1'
files:
  - packages/workflows/src/schema.ts
  - packages/workflows/test/schema-lifecycle-filter.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Extend the lifecycle variant of `TriggerSchema` (currently `packages/workflows/src/schema.ts:5`):

```ts
z.object({
  kind: z.literal('lifecycle'),
  event: z.enum(['session-start', 'pre-compact', 'stop', 'user-prompt-submit', 'post-tool-use']),
  filter: z.object({
    tool_name: z.array(z.string()).optional(),
  }).optional(),
}),
```

**Test**: a playbook with `filter: { tool_name: ['Edit', 'Write'] }` parses; missing filter still parses; filter is optional.

**Commit:** `feat(workflows): optional tool_name filter on lifecycle triggers`

### Task 1.2 — Hook command applies the filter

```yaml meta
id: '1.2'
files:
  - packages/cli/src/commands/hook.ts
  - packages/cli/test/commands/hook-lifecycle.test.ts
file_scope: extend-shared
depends_on: ['1.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

The hook command POSTs `{ event, cwd }` to `/workflows/trigger`. Extend the body to also include the originating `tool_name` from the Claude Code event payload (when present), e.g.:

```ts
body: JSON.stringify({
  event: { kind: 'lifecycle', event: lifecycleEvent },
  cwd,
  hookContext: { tool_name: ev.tool_name ?? null },
}),
```

The daemon route then reads `hookContext.tool_name` and skips workflows whose lifecycle trigger has a `filter.tool_name` array that doesn't include this tool. Also: if `hookContext.tool_name` is null and a workflow's filter is set, treat that as no-match (filters require a tool name to assert against).

**Test**: stub the daemon route's matching path with a fake registry, dispatch a `post-tool-use` event with `tool_name='Read'` against a workflow filtered to `['Edit','Write']` → no match. With `tool_name='Edit'` → matches.

**Commit:** `feat(daemon): /workflows/trigger applies lifecycle filter against hook tool_name`

### Task 1.3 — `delegate-suggest` playbook adopts the filter

```yaml meta
id: '1.3'
files:
  - plugin/playbooks/delegate-suggest/playbook.md
file_scope: modify-existing
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Update the `triggers:` block:

```yaml
triggers:
  - kind: lifecycle
    event: post-tool-use
    filter:
      tool_name: [Edit, Write]
```

After commit + daemon restart, smoke: read 5 turns of session-reminder text; the delegate-suggest reminder appears only after Edit/Write, not after Bash/Read/MCP/ToolSearch.

**Commit:** `feat(playbooks): delegate-suggest fires only after Edit/Write`

## Phase 2 — Tool-failure signal in the classifier

### Task 2.1 — Classifier returns `tool_failure_with_end_turn`

```yaml meta
id: '2.1'
files:
  - packages/core/src/services/dispatch-reliability.ts
  - packages/core/test/services/dispatch-reliability.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Extend `DispatchReliabilityStatus` enum (line ~10) with `'tool_failure_with_end_turn'`. Extend the classifier:

- Track `tool_failure_count = events.filter(e => e.kind === 'agent.tool_call.failed').length`.
- After the existing `no_worktree_activity` check, add:
  ```ts
  if (terminal && tool_failure_count > 0 && input.worktreeChanged === true) {
    return report('tool_failure_with_end_turn', false,
      `tool call failed during dispatch (${tool_failure_count}); end_turn reached without recovery`,
      'retry', []);
  }
  ```

The `worktreeChanged === true` guard ensures we don't double-fire when the silent-fail path (worktreeChanged === false) already triggers.

**Test**: seed events for an `agent.tool_call.failed` + `acp.session.end (end_turn)` + worktree_changed=true. Expect the new status, recommended_action='retry', trustworthy=false.

**Commit:** `feat(core): tool_failure_with_end_turn reliability class for silent-commit pattern`

### Task 2.2 — Worker retry trigger reads the new class

```yaml meta
id: '2.2'
files:
  - packages/agentchat/src/worker/silent-failure-retry.ts
  - packages/agentchat/test/worker/silent-failure-retry.test.ts
file_scope: extend-shared
depends_on: ['2.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

The retry-trigger predicate currently lives in `packages/agentchat/src/worker/silent-failure-retry.ts` (per the maestro-hooks Phase 1 commit). Extend the condition to include the new class:

```ts
perf.reliability_status === 'tool_failure_with_end_turn'
```

Add a test mirroring the existing `no_worktree_activity` test: perf row with `reliability_status='tool_failure_with_end_turn'` → retry triggers.

**Commit:** `feat(agentchat): retry on tool_failure_with_end_turn reliability class`

## Phase 3 — Manual-takeover tracking

### Task 3.1 — chain_cancel records takeover flag on agent_performance

```yaml meta
id: '3.1'
files:
  - packages/daemon/src/routes/chains.ts
  - packages/core/src/services/agent-performance-capture.ts
  - packages/core/test/services/agent-performance-capture.test.ts
file_scope: extend-shared
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

The `agent_performance.maestro_takeover_required` column already exists. When `chain_cancel` resolves a non-terminal handoff, write the perf row with that flag set true.

Heuristic for "recovery cancel" (vs duplicate / user-driven abort):
- If the handoff has no `dispatch.end` event yet AND was last active > 60s ago → recovery cancel → `maestro_takeover_required=true`.
- Otherwise → either a clean cancel or duplicate → flag stays false.

Implementation:
- Extend `captureAgentPerformanceFromDispatch` (or add a sibling) that takes an explicit `cancel_reason: 'recovery' | 'user_abort' | 'duplicate'`.
- The chains route at `packages/daemon/src/routes/chains.ts` (cancel handler) computes the heuristic and passes the reason in.
- The capture maps `'recovery'` to `maestro_takeover_required=true`; the others leave it false.

**Test**: synthetic handoff stuck dispatched > 60s, no dispatch.end → cancel through the route → assert agent_performance row has `maestro_takeover_required=1`.

**Commit:** `feat(core): chain_cancel-as-recovery sets maestro_takeover_required on perf row`

## Phase 4 — Stale-handoff sweeper

### Task 4.1 — Sweeper module

```yaml meta
id: '4.1'
files:
  - packages/daemon/src/sweepers/stale-handoff.ts
  - packages/daemon/test/sweepers/stale-handoff.test.ts
file_scope: new
depends_on: ['2.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

New sweeper (mirror `packages/daemon/src/sweepers/permission-ttl.ts` style — function exports, not a class). Public surface:

```ts
export interface StaleHandoffSweeperOpts {
  services: Services;
  staleAfterMs?: number;       // default 5 * 60_000
  cooldownMs?: number;         // default 60_000 per handoff
  log?: { warn?: (obj: unknown, msg?: string) => void };
}

export function runStaleHandoffSweep(opts: StaleHandoffSweeperOpts, state: { lastSwept: Map<string, number> }, now: () => Date): { resolved: string[] };
export function startStaleHandoffSweeper(opts: StaleHandoffSweeperOpts, intervalMs?: number, now?: () => Date): () => void;
```

Per tick:
1. Query handoffs where `status='dispatched' AND ts < now - staleAfterMs`.
2. For each, run `classifyDispatchReliability`.
3. If `report.status === 'non_terminal_stale'`:
   - Skip if cooldown active for this handoff (`lastSwept.get(handoff_id) > now - cooldownMs`).
   - Write a synthetic `dispatch.end` event with `status='failed', meta.reason='stale_force_resolve', meta.classifier_status='non_terminal_stale'`.
   - Mark the handoff status as `failed` directly via the handoff writer.
   - Update `lastSwept[handoff_id]`.
   - Push handoff_id to `resolved`.
4. The existing capture pipeline (running on the next worker tick, or triggered explicitly) sees the terminal event and runs computeDispatchSignals → AgentPerformanceWriter; the worker's retry trigger then fires on `non_terminal_stale`.

**Test**: insert a handoff with old `ts`, no `dispatch.end`, status `dispatched`. Run `runStaleHandoffSweep`. Assert returned `resolved` includes the handoff and a `dispatch.end` event was written.

**Commit:** `feat(daemon): stale-handoff sweeper force-resolves wedged dispatches`

### Task 4.2 — Wire sweeper into daemon boot

```yaml meta
id: '4.2'
files:
  - packages/daemon/src/serve.ts
file_scope: modify-existing
depends_on: ['4.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: bootstrap-touching
```

In `packages/daemon/src/serve.ts`, alongside the existing `startPermissionTtlSweeper(opts.services)` call (around line 325), add:

```ts
const stopStaleHandoffSweeper = startStaleHandoffSweeper({ services: opts.services });
```

Add `stopStaleHandoffSweeper()` to the shutdown path next to the other stop calls.

No new test — the unit test for the sweeper covers behavior.

**Commit:** `feat(daemon): boot stale-handoff sweeper alongside other sweepers`

## Acceptance criteria

1. **Phase 1**: `delegate-suggest` fires only after Edit/Write. Smoke: scroll the next ~10 turns of session reminders and confirm.
2. **Phase 2**: a synthetic dispatch with `agent.tool_call.failed + end_turn + worktree_changed=true` triggers auto-retry.
3. **Phase 3**: a `chain_cancel` against a non-terminal handoff produces an `agent_performance` row with `maestro_takeover_required=1`.
4. **Phase 4**: a wedged dispatch (no `dispatch.end` for > 5 min) auto-resolves to `failed` within 60s, and the worker's retry trigger fires.
5. Existing tests stay green; new tests cover each behavior change.

## Self-review

- Phase 1 ships independently and stops the visible noise immediately. Worth landing first.
- Phase 2 closes the silent-commit gap permanently; one incident this session, but the pattern is recurring per project memory (`feedback_dont_make_agents_kill_their_host_worker.md` gives the related "agent kills host" angle).
- Phase 3's heuristic for "recovery cancel" is imperfect — false positives possible if the user manually cancels a healthy in-progress dispatch. Acceptable trade-off; the maestro_takeover signal is advisory, used as a tiebreaker in agent.recommend.
- Phase 4 ties together the existing reliability classifier (Phase 1 of maestro-behavior-hooks) and the retry trigger. Without it, those two pieces are unreachable for the wedged-but-not-terminal case. This was the longest-tail incident in today's session (10+ min recovery).
- prompt-classify cosmetic empty-recall (Problem 5) deferred — see spec Out of Scope.
- Estimated total: 8 tasks across 4 phases. Comparable to maestro-behavior-hooks Phase 1+2 surface.
