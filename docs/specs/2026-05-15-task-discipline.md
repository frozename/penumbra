# Penumbra Task Discipline + Long-lived Refiner

Date: 2026-05-15
Scope: design spec for an ambient-observation → curated-backlog → autonomous-refinement → dispatch pipeline that captures "stumbles" (problems, ideas, gaps surfaced during work) as draft tasks and processes them into ready-to-dispatch FileTaskInput payloads via a long-lived refiner agent.
Constraint: no implementation in this document; design decisions only.

## 1. Motivation

This session alone produced ≥8 follow-up items that would have been lost to context drift if not explicitly held in memory or planned: the eval-plan T1 evaluation, Phases 2-4 of the cross-repo dispatch fix, the agent-worktree-tooling gap, the 128 unmerged branches triage, several adversarial findings we chose not to act on, and the design spec for this very system. The pattern repeats every session — penumbra accrues a long tail of "should do later" that lives only in maestro working memory or scattered docs/notes/ files.

The goal: turn the accidental discipline of ad-hoc note-taking into a first-class pipeline. Stumbles become observations the system can act on. A long-lived refiner brings them to a state where the existing task auctioneer + orchestrate-reactor can dispatch them autonomously, with a conservative human-review gate while the system is young.

## 2. Design decisions (from 2026-05-15 brainstorm)

### 2.1 Artifact model — hybrid

Three layers:

- **Raw observation** (`memory_observe` with `obs_type: 'task_draft'`) — cheap, lightweight, no new schema. Filed inline by agents whenever they stumble into something worth following up.
- **Draft task** (the same observation, lifecycle-tracked) — the observation gains a `draft_status` field over its lifecycle: `new → refining → promoted | stale | duplicate`.
- **Real task** (`tasks` table via `task_file`) — produced by the refiner when a draft is promoted. The existing task auctioneer + orchestrate-reactor route from here.

### 2.2 Filing mechanism — skill-led primary + Stop-hook safety net

Two redundant filers:

- **Skill-led inline filing**: `dispatching`, `brainstorming`, `maestro-context-prime`, and `session-handoff` skills get a new "stumble filing" section instructing agents to call `memory_observe` with the draft-payload shape (§3.1) whenever they spot future work before moving on.
- **Stop-hook safety net**: the existing `session-summarize` workflow (or a new sibling triggered on Stop) extracts unfiled stumbles from the session's transcript + dispatch events. Filed observations carry `via_hook: true`. De-dup runs against in-session inline filings via overlapping `evidence` pointers (commits, conv_ids, file paths).

### 2.3 Refiner output — FileTaskInput

The refiner produces `FileTaskInput` payloads (the existing penumbra task schema). The auctioneer + orchestrate-reactor pick up from `status: 'pending'`. The refiner is shaper-of-tasks, not a dispatch-decider. For multi-phase work, the refiner emits a single `kind: 'orchestrate'` task and plan-runtime takes over phase decomposition.

### 2.4 Confidence gate — conservative, layered architecture for later

Phase 1: every refined task lands with `requires_review: true` UNLESS the original draft observation was tagged `auto_ok: true` by the filing agent. The filer is the local authority on "this is small enough to fire without my review later." When the refiner promotes a draft with `auto_ok: true`, it sets `requires_review: false` on the produced task and the auctioneer auto-routes it.

Phase 2+ deferred layers (not in Phase 1, but the architecture is intentionally laid out to accept them):

- Scope heuristic on the produced task (file count, schema-touching, kind)
- Per-task cost budget + daily auto-dispatch cap
- Mini-adversarial-review on the refined task before dispatch
- Adaptive thresholds tuned from a `refiner_outcomes` ledger that records auto-dispatched task outcomes

### 2.5 Refiner agent — two-tier, granite-8b primary + claude-acp-fast escalation

Per `agentchat_local_model_calibration.md`, granite-4.1-8b-q4 is the proven memory-refiner role winner. Same model serves as primary refiner. When a draft exceeds the local model's confident-output budget (long context, ambiguous scope, cross-repo, low confidence on the produced FileTaskInput), the refiner files a sub-observation `obs_type: 'task_draft_escalation'` flagged for `claude-acp-fast` on the next tick. Two-tier matches the t2-promotion pool pattern already in production.

### 2.6 Cross-project filing — one observation, fan-out

A single draft observation carries `affects_projects: ['penumbra', 'llamactl', ...]`. The refiner fans out: one `task_file` per affected project. All produced tasks share `parent_observation_id` for traceability. Most common case is `len(affects_projects) === 1`; the fan-out path engages cleanly when cross-repo stumbles arise (e.g., the cross-repo-dispatch-trap surfaced 3 tasks across 2 repos from a single stumble).

### 2.7 Staleness — active check + TTL backstop

On every refiner tick, before producing FileTaskInput for a draft:

- Active check 1: do the referenced `evidence` paths still exist on disk?
- Active check 2: does `git log --grep` of the draft's `prompt` against the affected projects' main reveal a commit that likely resolved this stumble?
- Active check 3: does a pending task in `affects_projects` already cover this scope (heuristic: prompt text overlap > 0.7)?

Any check → `draft_status: 'stale'` with `stale_reason: 'resolved_by_<commit_sha>' | 'duplicate_of_<task_id>' | 'path_removed'`.

TTL backstop: drafts older than 14 days with `draft_status: 'new'` (never picked) auto-stale with `stale_reason: 'ttl_expired'`. Drafts older than 30 days with `draft_status: 'refining'` (stuck) get force-released and retried once, then stale.

### 2.8 Cadence — cron-driven 15 min ticks

`schedule_cron: '*/15 * * * *'`. Per-tick budget: 5 drafts max. Predictable cost (~$0.05/day at granite-8b), proven home-mgmt pattern. Event-driven burst trigger deferred until evidence shows cron lag matters in practice.

## 3. Schema

### 3.1 Draft observation payload (memory_observe)

```json
{
  "obs_type": "task_draft",
  "project_id": "<filer's current project>",
  "payload": {
    "prompt": "<one-paragraph description of the stumble + suggested next action>",
    "affects_projects": ["penumbra"],
    "evidence": {
      "conv_ids": ["conv-xxx"],
      "commits": ["abcdef1"],
      "files": ["packages/mcp/src/tools/chain-start.ts:78"],
      "session_id": "<session id>"
    },
    "auto_ok": false,
    "draft_status": "new",
    "filed_by_agent": "<agent name>",
    "filed_via": "skill_inline" | "stop_hook",
    "parent_observation_id": "<for de-dup; null otherwise>"
  }
}
```

### 3.2 Lifecycle additions to the observation

The observation's lifecycle is tracked in-place via mutable `payload.draft_status`, `payload.task_ids`, `payload.stale_reason`. No new table.

Statuses:
- `new` — filed, not yet picked by refiner
- `refining` — current refiner tick is processing this; set at pick-up time, cleared at exit
- `promoted` — refiner produced one or more tasks; `task_ids: [...]` populated
- `stale` — staleness check or TTL fired; `stale_reason: string`
- `duplicate` — refiner found an existing pending task covering the scope; `duplicate_of_task_id`

### 3.3 Produced tasks

Standard `FileTaskInput` rows. No new fields. The refiner sets `created_by_kind: 'agent'`, `created_by_id: 'task-refiner-<tier>'`, `origin: 'observation:<observation_id>'`. The `parent_observation_id` link is captured in `origin`.

## 4. Refiner long-lived agent definition

Yaml shape (matches existing long-lived agents in `~/.config/agentchat/agentchat.yaml`):

```yaml
- id: task-refiner-primary
  display_name: task-refiner-primary
  schedule_cron: "*/15 * * * *"
  initial_agent: granite41-8b-q4-local
  subscriptions: []
  mcp_allowlist:
    - penumbra:memory_search
    - penumbra:memory_observe
    - penumbra:task_file
    - penumbra:task_list
    - penumbra:task_get
    - penumbra:agent_recommend
    - penumbra:long_lived_self_state_get
    - penumbra:long_lived_self_state_set
    - penumbra:long_lived_self_pending_actions
  approval_required_globs: []
  cooldown_overrides: {}
  bounds:
    wall_clock_ms: 180000
    max_sub_dispatches: 5
```

System prompt (sketch): "You are the task refiner. Each tick you pull pending draft observations, run staleness checks, and for surviving drafts produce FileTaskInput payloads to file via task_file. You set requires_review based on the draft's auto_ok tag. When a draft exceeds your confident-output budget, file a task_draft_escalation observation tagged for claude-acp-fast instead of producing a task yourself."

A sibling `task-refiner-escalation` agent (initial_agent: claude-acp-fast) ticks on the same cadence but only processes drafts with `obs_type: 'task_draft_escalation'`.

## 5. Integration touchpoints

- `packages/core/src/schemas/event.ts` — extend the t0 observation schema's `obs_type` enum to include `task_draft` and `task_draft_escalation`
- `packages/core/src/tasks/schema.ts` — no changes; reuse FileTaskInputSchema
- `~/.config/agentchat/agentchat.yaml` — add the two long-lived agent definitions
- `plugin/skills/dispatching/SKILL.md`, `brainstorming/SKILL.md`, `maestro-context-prime/...`, `session-handoff/...` — add "stumble filing" sections
- `plugin/playbooks/session-summarize/playbook.yaml` (or new sibling) — add the Stop-hook extraction logic
- New: a small `dispatch-routing-guard`-style heuristic file at `packages/core/src/services/stumble-extractor.ts` for the Stop hook's transcript-scan logic
- No daemon code changes for Phase 1; the refiner uses existing MCP surface end-to-end

## 6. Phasing

### Phase 1 — Minimum viable discipline (ship-now)

1. Schema: `obs_type: 'task_draft'` accepted by `memory_observe` (one line in event schema enum)
2. Skill instruction patches across the 4 named skills
3. `session-summarize` extension for Stop-hook extraction
4. `task-refiner-primary` long-lived agent definition (yaml + system prompt + initial working_memory)
5. Conservative gate only (requires_review=true unless auto_ok)
6. Active staleness checks + TTL backstop

Acceptance: at the end of one full day with skills + hook + refiner in place, the count of draft observations filed > 0, the count of promoted tasks > 0, and at least one promoted task auto-dispatched (auto_ok path) without human intervention.

### Phase 2 — Escalation tier

1. `task-refiner-escalation` agent (claude-acp-fast based)
2. Escalation observation `obs_type: 'task_draft_escalation'`
3. Escalation routing logic in primary refiner's system prompt

Acceptance: at least one draft escalated from primary to escalation tier resolves successfully (produces a usable task).

### Phase 3 — Layered confidence gate

1. Scope heuristic on produced task (file count, schema-touch detection)
2. Cost budget per task + daily auto-dispatch cap
3. Mini-adversarial-review on refined task (1 persona, fast model) when other gates pass
4. `refiner_outcomes` ledger table for tracking auto-dispatched task outcomes

Acceptance: false-auto rate (auto-dispatched tasks that get reverted or fail review) < 5% over the prior 7 days.

### Phase 4 — Adaptive thresholds + event-driven cadence

1. Refiner reads `refiner_outcomes` to tune its own scope/cost thresholds weekly
2. Add event-driven burst trigger when N drafts arrive within a window

Acceptance: cron tick interval can be relaxed to 30 min without measurable refinement-lag impact on observed patterns.

## 7. Open questions deferred

- Cross-repo task-task linking (when one project's task blocks another's): out of Phase 1 scope, revisit when patterns emerge
- Drafts that span specs/features rather than discrete tasks: refiner currently produces tasks only; bigger-than-task drafts might need a different output (a spec doc?). Phase 1 default: refiner produces orchestrate-kind tasks for these and lets plan-runtime decompose
- Migration: do existing memory entries like `docs/notes/eval-plan-chain-start-prompt-refining.md` retro-eligible as drafts? Initial answer: no, they're explicit docs. Future: maybe a `task_draft_import` workflow if useful
- Visibility: does the `/quality_status` MCP tool need a refiner-status section showing draft inbox depth, refiner lag, recent promotions? Defer until we have data

## 8. Success criteria for the discipline (not the system)

- "Stumble → filed" lag time < 5 min in 90% of cases (measured via session-end stumble count vs observation count)
- "Filed → refined" lag time < 30 min in 90% of cases (single cron tick)
- Auto-dispatch success rate (promoted task lands without revert) ≥ 90%
- Human review queue depth ≤ 10 pending tasks across all projects (above this, the gate is too conservative; tune scope heuristic up)

These metrics inform Phase 3 threshold tuning. Track via existing `t0_events` + `tasks` tables; no new ledger needed for Phase 1.
