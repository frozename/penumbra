# Dispatch and Agent Reliability Design

**Status:** spec
**Date:** 2026-05-01
**Authors:** Alexandre Cordeiro

## 1. Goal

Make Penumbra dispatch and delegated agent work trustworthy enough that a maestro can rely on the system's evidence instead of judging by silence, memory, or agent self-report.

The target is not literal perfect execution from external CLIs and cloud models. The target is a stronger contract:

- Every dispatch has a complete, queryable lifecycle.
- Every dispatch has a bounded and classified failure mode.
- Every completed agent result has observable evidence.
- Every routing decision can be explained from reliability and performance data.
- Every operator-facing status includes the next safe action.

## 2. Current state

Penumbra already has several foundations:

- Durable handoff rows, statuses, cancellation markers, worker IDs, and chain metadata.
- `dispatch_events` instrumentation for worker, daemon, watchdog, cancel, heartbeat, and process lifecycle events.
- CLI process-group cancellation and signal-aware process exit handling in `cli-spawn`.
- Worktree management and MCP worktree inspection tools.
- Agent performance capture and task-type ranking.
- Role routing via `agentchat.yaml`, including configurable exploration policy.

The missing layer is a single reliability contract that joins these surfaces and classifies dispatch trust. Today a maestro can inspect status, timeline, worktree, responses, and ledger rows independently. This design adds the shared classifier and enforcement surfaces that make those signals actionable.

## 3. Non-goals

- No automatic retries in the first slice.
- No automatic edits to `agentchat.yaml`.
- No model-provider-specific policy beyond adapter capability metadata.
- No new Discord routing behavior.
- No attempt to prove external providers are reliable.
- No replacement for human code review.

## 4. Reliability model

Add a core `DispatchReliabilityReport` that classifies one handoff from observable evidence.

Inputs:

- Handoff row.
- Dispatch events for the handoff.
- Chain messages and final responses.
- Worktree inspection summary when available.
- Reconciler outcome when available.
- Agent performance row when available.
- Adapter metadata when available.

Output:

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
  recommended_action:
    | 'wait'
    | 'inspect_worktree'
    | 'cancel'
    | 'retry'
    | 'review_manually'
    | 'accept';
}
```

The classifier is pure and deterministic. Daemon, CLI, MCP, routing, and ledger code must consume this helper instead of duplicating classification rules.

## 5. Lifecycle contract

A trustworthy dispatch lifecycle has these phases:

1. `handoff.created` exists in the handoff table.
2. Worker claims the handoff.
3. Worker records `dispatch.start`.
4. Adapter records at least one lifecycle event:
   - CLI adapters: `proc.spawn` plus a terminal process event.
   - HTTP adapters: request start/end or error.
   - ACP adapters: session start/end or error.
5. Worker records `dispatch.end`.
6. Handoff reaches exactly one terminal state.
7. Result evidence exists:
   - Implementation: worktree diff or explicit `no_changes` outcome, plus reconciliation result.
   - Review: non-empty final response with source-backed findings or explicit no-findings statement.
8. Agent performance capture records the outcome when applicable.

Partial or missing evidence is not necessarily a bug, but it must classify as untrusted until a maestro reviews it.

## 6. Classification rules

### `complete`

Terminal handoff with complete lifecycle events and expected result evidence.

Recommended action: `accept`.

### `missing_dispatch_start`

Handoff exists and is claimed or terminal, but no `dispatch.start` event exists.

Recommended action: `review_manually` for terminal rows, `retry` for failed rows.

### `missing_adapter_lifecycle`

`dispatch.start` exists, but no adapter-level lifecycle event exists.

Recommended action: `review_manually`.

### `missing_dispatch_end`

Adapter lifecycle exists, but no `dispatch.end` event exists.

Recommended action: `review_manually` if terminal, `wait` or `cancel` if non-terminal depending on age.

### `non_terminal_stale`

Handoff is non-terminal and older than a caller-provided threshold.

Recommended action: `inspect_worktree` for buffered adapters; `cancel` for streaming adapters with no progress.

### `cancel_completed`

Handoff has `cancel_requested_at` and later reaches `completed`.

Recommended action: `review_manually`.

### `watchdog_only`

Handoff failed by watchdog without a worker-side `dispatch.end`.

Recommended action: `retry` after inspecting timeline.

### `no_agent_output`

Terminal handoff has no final response or only empty text.

Recommended action: `retry`.

### `no_worktree_activity`

Implementation task completed without worktree changes and without explicit `no_changes`.

Recommended action: `review_manually`.

### `reconcile_missing`

Implementation task has worktree changes but no reconciliation result.

Recommended action: `review_manually`.

### `agent_declared_done_unverified`

Agent final text claims completion, but expected artifacts or verification evidence are absent.

Recommended action: `review_manually`.

### `timeline_inconsistent`

Event order is impossible, duplicated terminal lifecycle events exist, or mutually exclusive states appear.

Recommended action: `review_manually`.

## 7. Audit surfaces

Expose the classifier through these surfaces:

- HTTP: `GET /dispatch/audit?handoff_id=<id>`
- CLI: `penumbra dispatch audit <handoff_id> [--json]`
- MCP: `dispatch.audit({ handoff_id })`

The CLI human output should be compact:

```text
handoff: h-123
status: watchdog_only
trustworthy: no
summary: watchdog failed the handoff without dispatch.end
recommended_action: retry
missing_events: dispatch.end
```

The JSON output returns the full `DispatchReliabilityReport`.

## 8. Smoke harness

Add a worker-path reliability smoke harness under:

```text
packages/agentchat/scripts/reliability-smoke/
```

The harness runs against the real daemon and worker path where possible. It should not replace unit tests. Its job is to prove cross-process behavior.

Required scenarios:

| Scenario | Expected classification |
|---|---|
| `success_with_output` | `complete` |
| `empty_success` | `no_agent_output` |
| `stderr_only` | `no_agent_output` or adapter error |
| `nonzero_exit` | `complete` with failed terminal status |
| `signal_exit` | `complete` with failed terminal status |
| `cancel_process_group` | `complete` with cancelled or failed terminal status |
| `implementation_no_diff` | `no_worktree_activity` |
| `review_no_sources` | `agent_declared_done_unverified` |
| `watchdog_missing_end` | `watchdog_only` |

The first implementation can use local fake CLI agents configured in a test-local `agentchat.yaml` so it does not spend provider quota.

## 9. Agent work verification contract

Dispatch completion must be separated from result trust.

### Implementation task requirements

Implementation handoffs are trustworthy only when all required evidence exists:

- Worktree diff or explicit `no_changes` classification.
- Branch log.
- Reconciliation result.
- Verification command and outcome when the plan requested tests.
- Non-empty final response.

### Review task requirements

Review handoffs are trustworthy only when:

- Final response is non-empty.
- Response either lists source-backed findings or explicitly says no findings.
- The inspected scope is recorded in the prompt, response metadata, or attached content.
- The response does not cite files outside available scope.

The initial implementation can enforce only structural evidence. Content quality checks can be added later through reviewer calibration tasks.

## 10. Reliability ledger

Extend agent performance tracking so routing can distinguish quality from infrastructure failures.

Add reliability fields to captured agent outcomes:

- `reliability_status`
- `failure_class`
- `artifact_present`
- `verification_present`
- `maestro_takeover_required`
- `empty_response`
- `worktree_changed`
- `reconcile_status`
- `environment_failure`
- `trust_score`

Trust score should reward:

- Clean first-shot completion.
- Verified tests.
- Source-backed review.
- Agent surfaced a real architectural concern.
- Clean reconciler result.

Trust score should penalize:

- Empty output.
- No artifact for implementation tasks.
- Missing verification.
- Fabricated or unbacked review claims.
- Watchdog-only failures.
- Maestro takeover.

Environment failures should be recorded separately so a broken local auth setup can pause a route without permanently reducing model-quality score.

## 11. Maestro guardrails

Improve operator guidance so status surfaces say what to do next.

`chain_status` or a companion audit surface should include:

- Adapter class.
- Whether the adapter streams output.
- Current lifecycle phase.
- Last dispatch event.
- Last progress timestamp.
- Worktree changed state when available.
- Reliability status.
- Recommended next action.

Cancellation guardrail:

- For buffered CLI adapters, response silence alone should recommend `inspect_worktree`.
- For streaming adapters with no progress past threshold, silence can recommend `cancel`.
- Force cancellation remains available, but it should be an explicit operator choice.

## 12. Acceptance criteria

This reliability effort is complete when:

1. `DispatchReliabilityReport` is implemented and unit-tested.
2. HTTP, CLI, and MCP audit surfaces return the same report.
3. Worker-path smoke harness covers the required scenarios.
4. Agent performance capture stores reliability evidence.
5. Role routing can include trust score without breaking existing rank behavior.
6. Maestro-facing status includes a recommended next action.
7. A 1-week soak records reliability reports for real dispatches without unclassified terminal states.

## 13. Phasing

### Phase 1: Audit foundation

Build the pure classifier and expose `dispatch audit`.

### Phase 2: Smoke harness

Add repeatable worker-path reliability smoke tests.

### Phase 3: Agent artifact verification

Require evidence for implementation and review trust.

### Phase 4: Reliability ledger and routing

Store reliability outcomes and fold trust into rank.

### Phase 5: Guardrails and soak

Add recommended next actions to maestro surfaces and run the soak.
