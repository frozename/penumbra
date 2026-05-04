# Maestro Behavior Hooks — Implementation Plan

Date: 2026-05-04
Spec: `docs/superpowers/specs/2026-05-04-maestro-behavior-hooks-design.md`
Status: Ready (Phase 1 actionable; Phases 2–4 require envelope discovery — see Pre-flight)

## Pre-flight

- Tests: `import { expect, test } from 'bun:test';` Real sqlite via `loadSqliteVec` + `migrate`. `TestEmbedder` from `@penumbra/core/testing`.
- **Open question blocking Phases 2–4:** Claude Code's hook stdout envelope. SessionStart and UserPromptSubmit hooks accept stdout-injected context, but the exact JSON shape (`{ "hookSpecificOutput": { "additionalContext": "..." } }` vs plain text) needs to be verified by reading Claude Code release notes / settings.json hook docs. Discovery task at the head of Phase 2.
- Phase 1 (silent-fail extension) doesn't depend on the hook envelope and ships independently.
- Daemon does NOT need to restart between Phases 1–3. Phase 4 needs one restart at the end.

## Dispatch graph (this plan, executed)

```
1.1 → 1.2          (classifier exposes reliability → worker retry trigger reads it)
2.1                (envelope discovery — research/probe, single task)
3.1 → 3.2          (session-reminder sink → maestro-context-prime playbook)
4.1 → 4.2          (prompt-classify playbook → delegate-suggest playbook)
```

Phase 1 ships immediately. Phases 2–4 gated on 2.1 outcome.

## Phase 1 — Close the silent-failure blind spot

### Task 1.1 — Surface reliability classification at dispatch-end

```yaml meta
id: '1.1'
files:
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

Extend `captureAgentPerformanceFromDispatch` to compute the dispatch-reliability classification (today's `dispatch-reliability.ts`) at capture time and persist `reliability_status` on the agent_performance row. The column already exists.

Read `packages/core/src/services/dispatch-reliability.ts:classifyDispatch` — call it with the same inputs `computeDispatchSignals` already aggregates. Map `report.status` → `agent_performance.reliability_status`. Map `report.recommended_action` to a new `notes` augmentation (e.g. include `recommended_action=cancel` in `notes` when the action is `cancel` — gives the worker something to key on without a new column).

Tests: seed dispatch_events for three scenarios (clean success, silent fail, non-terminal stale) and assert each produces the expected `reliability_status`.

**Commit:** `feat(core): persist reliability_status on agent_performance via classifier`

### Task 1.2 — Worker retry trigger reads reliability

```yaml meta
id: '1.2'
files:
  - packages/agentchat/bin/agentchat-worker.ts
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: small
risk_class: bootstrap-touching
```

Currently at `agentchat-worker.ts:544`:
```ts
if (perf && perf.outcome === 'failed' && perf.notes?.includes('silent_failure')) {
```

Extend the retry trigger to also fire when:
- `perf.reliability_status === 'no_worktree_activity'` regardless of outcome (catches the success+no-activity slip), OR
- `perf.reliability_status === 'non_terminal_stale'` AND `perf.notes?.includes('recommended_action=cancel')` (catches the haiku stall pattern).

Keep the existing `SILENT_RETRY_PREFIX` guard — bound to one retry per chain. Add a smoke-style test that constructs a perf row with each reliability_status and asserts the retry attempt happens.

**Commit:** `feat(agentchat): retry on no_worktree_activity + non_terminal_stale reliability classes`

## Phase 2 — Envelope discovery (research)

### Task 2.1 — Probe Claude Code hook envelope for context injection

```yaml meta
id: '2.1'
files:
  - docs/notes/claude-code-hook-envelope.md
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: maestro-inline
fallback_agent: maestro-inline
task_size: small
risk_class: paste-ready
```

Maestro probes Claude Code's hook docs / source to determine the correct stdout envelope for SessionStart and UserPromptSubmit hooks to inject `<system-reminder>` content. Test by writing a trivial hook that emits `{"hookSpecificOutput":{"additionalContext":"PROBE_TOKEN"}}` and confirming `PROBE_TOKEN` appears in the next assistant turn. Document findings in `docs/notes/claude-code-hook-envelope.md` so the next phases have a verified contract.

No commit unless the probe lands a documentation note (single-file, paste-ready).

## Phase 3 — Session-reminder output sink + maestro-context-prime playbook

### Task 3.1 — `session-reminder` output sink

```yaml meta
id: '3.1'
files:
  - packages/workflows/src/schema.ts
  - packages/workflows/src/outputs/session-reminder.ts
  - packages/workflows/src/exec.ts
  - packages/workflows/test/outputs/session-reminder.test.ts
file_scope: extend-shared
depends_on: ['2.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-fast
task_size: substantial
risk_class: schema-aware
```

Add `session-reminder` variant to `OutputSinkSchema`. New sink writes the rendered template to stdout in the envelope determined by 2.1 (e.g. `{ hookSpecificOutput: { additionalContext: "<rendered>" } }`). The envelope spec lives in `docs/notes/claude-code-hook-envelope.md`.

Wire into `executeWorkflow`'s output dispatcher.

**Commit:** `feat(workflows): session-reminder output sink for hook context injection`

### Task 3.2 — `maestro-context-prime` playbook

```yaml meta
id: '3.2'
files:
  - plugin/playbooks/maestro-context-prime/playbook.md
file_scope: new
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

New playbook with:
- trigger: `lifecycle:session-start`
- recall: `memory.search` (top 10 today, project-scoped), `git.log --since=midnight`, `dispatch_events` (last 5 with workflow_outcome filter)
- output: `session-reminder` (single sink)
- run: markdown-template that renders ~300 tokens of "you are maestro in {{project}}; recent activity: ...; suggested workflows: ..."

**Commit:** `feat(playbooks): maestro-context-prime — session-start system reminder`

## Phase 4 — Prompt-classify + delegate-suggest

### Task 4.1 — `prompt-classify` playbook

```yaml meta
id: '4.1'
files:
  - plugin/playbooks/prompt-classify/playbook.md
  - packages/cli/src/commands/hooks.ts
file_scope: extend-shared
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Add a `lifecycle:user-prompt-submit` event to PENUMBRA_HOOK_EVENTS forwarding (verify it's already in the list — `hooks.ts:320` shows `UserPromptSubmit` is registered). Add to the lifecycle event enum if needed.

New playbook:
- trigger: `lifecycle:user-prompt-submit`
- recall: `memory.search` (using prompt as query — needs a way for recall to access the hook payload's prompt; either pre-resolve via template var `{{prompt}}` or extend recall to accept `args.query: '@hookPayload.prompt'`)
- output: `session-reminder`

**Commit:** `feat(playbooks): prompt-classify — pre-flight memory + workflow suggestion`

### Task 4.2 — `delegate-suggest` playbook

```yaml meta
id: '4.2'
files:
  - plugin/playbooks/delegate-suggest/playbook.md
file_scope: new
depends_on: ['4.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

New playbook:
- trigger: `lifecycle:pre-tool-use` filtered to `tool_name in [Write, Edit]`. (Need to add filter capability to lifecycle trigger schema if not already present.)
- run: `ts-function` that classifies the impending edit by hook payload (file count, line-count proxy from `tool_input`); emits a `session-reminder` with delegation suggestion when classified as substantial.

**Commit:** `feat(playbooks): delegate-suggest — PreToolUse advisory for substantive edits`

## Acceptance criteria

1. After Phase 1, dispatches that complete with `reliability_status='no_worktree_activity'` auto-retry on a different agent — verified by inducing a no-op gemini dispatch and observing retry.
2. After Phase 2, the hook-envelope contract for context injection is documented and verified end-to-end.
3. After Phase 3, fresh sessions emit a system reminder including ≥3 recent activity items.
4. After Phase 4, substantive Edit/Write actions trigger a delegation suggestion ≥ 80% of the time across a 20-session sample.

## Self-review

- Phase 1 lands the highest-value, lowest-risk piece independently. Worth shipping even if Phases 2–4 stall on the envelope question.
- Phase 2 is research-only by design — defer the speculative authoring of injection-dependent workflows until the contract is real.
- The maestro-inline assignments in Phase 2 are intentional: this work isn't dispatchable (it requires interactive probing of the live Claude Code harness).
- Estimated total: ~6 substantive tasks plus one research probe. Comparable in size to Phase 1 of dispatch-aware-plan-format.
