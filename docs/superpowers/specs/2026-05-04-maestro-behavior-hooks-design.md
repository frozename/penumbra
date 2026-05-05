# Maestro Behavior Hooks

**Status:** Shipped 2026-05-05 (commits `40bcb3d` … `2273510`) · **Scope:** Maestro behavior hooks — recall before action, dispatch by default, close silent-failure blind spot · **Plan:** `docs/superpowers/plans/2026-05-04-maestro-behavior-hooks.md`.

**Implementation summary:**

- 7 tasks across 4 phases shipped against this spec.
- Phase 1 (silent-fail): `40bcb3d` (reliability_status persisted) + `54d00a1` (worker retry on no_worktree_activity + non_terminal_stale reliability classes).
- Phase 2 (envelope discovery): `1251ca7` documented the Claude Code stdout envelope at `docs/notes/claude-code-hook-envelope.md`.
- Phase 3 (session-reminder + context-prime): `d501323` (session-reminder output sink) + `a4fc2f0` (maestro-context-prime playbook), refined later by `5c720a1` and `fd8e29c`.
- Phase 4 (prompt-classify + delegate-suggest): `278f505` (initial wiring with lifecycle enum extension) + `cdd24aa` (recall returns recent activity instead of literal session-string matches) + `2273510` (delegate-suggest narrowed to fire on PostToolUse for Edit/Write only).
- One deviation from spec letter: `delegate-suggest` shipped against `lifecycle:post-tool-use` filtered to `tool_name in [Edit, Write]`, not `pre-tool-use` as the spec proposed. Rationale: post-tool-use is evidence-based (the edit happened, so the advisory is grounded), whereas pre-tool-use would warn pre-emptively before knowing the edit's actual size — high false-positive rate in practice.
- Adjacent surface that landed alongside but is not part of this spec: `7769ff9` introduced a `file-context` playbook + `pre-tool-use` lifecycle event + `file_path` template var. Recorded here for traceability; tracked as separate scope.
## Summary

The maestro reads CLAUDE.md/AGENTS.md and memories at session start but doesn't *automatically* recall-before-action or dispatch-by-default. The user has to keep nudging ("did you check memory?", "delegate this"). Use Claude Code lifecycle hooks (now wired through `/workflows/trigger`) to make these behaviors habitual without every session re-instructing. Also closes the auto-retry blind spot where `outcome=success` paired with `reliability=no_worktree_activity` slips past the silent-failure detector.

## Problem

Three behavioral gaps:

**1. No automatic context priming at session start.** The maestro's workflow is documented in CLAUDE.md/AGENTS.md, but model attention drifts across long sessions. SessionStart fires today (we wired the lifecycle forwarder in Phase 11) but only routes the event to `/workflows/trigger`; no workflow currently subscribes to it with a *system reminder injection* that primes the maestro role.

**2. No recall-before-action gate.** When the user gives a task, the maestro often jumps straight to action (dispatch / edit) without first searching memory for related past work. Memories surfaced retroactively are wasted effort if the wrong path was already chosen.

**3. Dispatch trust is uneven.** When dispatched agents silent-fail (gemini stalls, oc-acp drops mid-dispatch), the maestro can't confidently delegate. The auto-retry net catches most failures but `reliability=no_worktree_activity` paired with `outcome=success` (per the Task 2.2 incident from prior session, reproduced this session on Tasks 7.1 + 8.4) still requires manual cleanup. If we want maestro to dispatch *naturally*, the dispatch substrate has to be more trustworthy.

## Goal

A maestro that:
- recalls related memory and looks up workflow history *before* responding to non-trivial requests
- treats dispatching as the default for substantive code changes (manual implementation = exception, not norm)
- can trust silent-fail detection so delegation isn't anxiety-inducing

…all without re-instruction every session.

## Design

### A. SessionStart workflow with context injection

A new `maestro-context-prime` workflow:

- **trigger**: `lifecycle:session-start`
- **recall**: today's project memories (top 10), today's commits, last 5 workflow_outcome rows
- **output**: `kind: session-reminder` (new sink) — emits a JSON payload that Claude Code's hook system reads and injects as a `<system-reminder>` block at session start

The reminder's content is small (~300 tokens): "You're maestro in penumbra. Recent activity: [3 lines]. Three workflows match recent activity: /handoff, /brainstorm. Reminder: dispatch via chain_start (don't hand-implement); recall via memory.search before substantive work; the daemon is at port 51257 (verify via launchctl)."

This gives the model a refreshed mental model every session without the user typing it.

### B. UserPromptSubmit pre-flight recall

A new `prompt-classify` workflow:

- **trigger**: `lifecycle:user-prompt-submit` (need to add this to PENUMBRA_HOOK_EVENTS)
- **run**: TS function (`kind: ts-function`) that:
  1. Pulls the prompt text from the hook payload
  2. Calls `workflow.suggest` against current state thresholds
  3. Calls `memory.search` with the prompt as query (top 5)
  4. Surfaces results as a hook-injected reminder: "Related memories: [list]. Possibly applicable workflow: <name> — invoke with /<slash>?"
- **output**: `kind: session-reminder`

The injected reminder is advisory, not blocking. Model can ignore. But it puts the relevant context in front of the model for free, eliminating the "did you check memory?" prompts.

### C. PreToolUse delegation suggestion

A new `delegate-suggest` workflow:

- **trigger**: `lifecycle:pre-tool-use` filtered to `tool_name in [Write, Edit]`
- **run**: TS function that classifies the impending edit:
  - small (<50 lines, single file, no test changes) → no suggestion
  - substantial (multiple files OR test file + source OR new feature) → emit reminder: "This edit looks substantial — consider `chain_start` with `claude-acp-sonnet` for risky surfaces or `codex-acp-fast` for paste-ready changes. Inline the change only if the daemon won't boot."
- **output**: `kind: session-reminder`

This lets the maestro dispatch by default without the user having to remind them.

### D. Close the silent-failure blind spot

In `packages/agentchat/src/dispatch/reliability.ts` (or wherever silent-failure classification lives), extend the trigger condition for auto-retry:

```ts
// Currently: only fires when outcome=failed
// Add: fire when outcome=success AND reliability.status === 'no_worktree_activity'
//   AND artifact_count === 0 AND latency_seconds < 60
```

This catches the gemini/haiku stall pattern where the agent returns "success" with no actual changes. The classifier already records `reliability.status` per the latest changes; just need to wire it into the retry trigger.

Optional: also extend to the `non_terminal_stale` reliability class (the haiku 8.4 stall was this — handoff went stale at 5m, recommended_action was `cancel`). When auto-retry sees `non_terminal_stale`, cancel + re-dispatch to a different agent (codex-acp-fast as default fallback per this session's reliability data).

## Integration points

- `packages/cli/src/commands/hooks.ts` — extend `PENUMBRA_HOOK_EVENTS` with `UserPromptSubmit` (already there) and verify hook output format propagates as system-reminder injection.
- `packages/workflows/src/outputs/` — new sink `session-reminder` that emits JSON-on-stdout for hook consumption.
- `packages/workflows/src/schema.ts` — add `session-reminder` to `OutputSink` discriminator.
- `packages/agentchat/src/dispatch/reliability.ts` — extend silent-failure detection.
- `plugin/playbooks/maestro-context-prime/playbook.md` — author new playbook.
- `plugin/playbooks/prompt-classify/playbook.md` — author new playbook.
- `plugin/playbooks/delegate-suggest/playbook.md` — author new playbook.

## Acceptance criteria

1. After 1 day of use, the user does not need to re-explain dispatch/recall conventions in any session.
2. Silent-fail rate (per-week count of `reliability=no_worktree_activity` dispatches that don't auto-retry) drops to 0.
3. New session start emits a system reminder that includes 3+ recent activity items and 1+ workflow suggestion.
4. Substantive Edit/Write actions trigger a delegation suggestion reminder ≥ 80% of the time (sample: 20 sessions).
5. The user reports the maestro "feels more autonomous" — qualitative but the load-bearing acceptance bit.

## Risks

- **Hook noise.** Three new hook outputs per turn risks spam. Mitigation: the reminders are short (≤300 tokens combined), and PreToolUse filtering keeps the delegate-suggest reminder rare.
- **Suggestion fatigue.** If the model ignores reminders, escalating to harder gates (refusing to Write without going through chain_start first) is an option but feels paternalistic. Start advisory, escalate only with evidence.
- **Latency on UserPromptSubmit.** memory.search + workflow.suggest + render ≈ 50–200 ms. Acceptable for non-tab-completion contexts.

## Open questions

- Does Claude Code's hook system actually accept system-reminder injection from arbitrary hook output, or do we need a specific JSON envelope? Verify against the hook docs before committing to the `session-reminder` sink design.
- For PreToolUse, is the hook payload's `tool_input` rich enough to classify edit size, or do we need a separate workflow that runs *after* the edit and learns from it?
