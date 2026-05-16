# Penumbra Task Discipline + Long-lived Refiner

Date: 2026-05-15
Scope: design spec for an ambient-observation → curated-backlog → autonomous-refinement → dispatch pipeline that captures "stumbles" (problems, ideas, gaps surfaced during work) as draft tasks and processes them into ready-to-dispatch FileTaskInput payloads via a long-lived refiner agent.
Constraint: no implementation in this document; design decisions only.

## 1. Motivation

This session alone produced ≥8 follow-up items that would have been lost to context drift if not explicitly held in memory or planned: the eval-plan T1 evaluation, Phases 2-4 of the cross-repo dispatch fix, the agent-worktree-tooling gap, the 128 unmerged branches triage, several adversarial findings we chose not to act on, and the design spec for this very system. The pattern repeats every session — penumbra accrues a long tail of "should do later" that lives only in maestro working memory or scattered docs/notes/ files.

The goal: turn the accidental discipline of ad-hoc note-taking into a first-class pipeline. Stumbles become observations the system can act on. A long-lived refiner brings them to a state where the existing task auctioneer + orchestrate-reactor can dispatch them autonomously, with a conservative human-review gate while the system is young.

## 2. Design decisions (from 2026-05-15 brainstorm)

### 2.1 Artifact model — hybrid (append-only T0 events)

Three layers:

- **Raw observation** (`memory_observe` with `event_type: 'task_draft'`) — filed inline by agents via the existing MCP surface; just a new variant in the `event_type` enums.
- **Draft task** (a logical entity reconstructed from the t0_events stream) — the *current state* of a draft is the most recent lifecycle event sharing the same `payload_json.draft_id`. States: `new → refining → promoted | stale | duplicate | escalated`.
- **Real task** (`tasks` table via `task_file`) — produced by the refiner when a draft is promoted. The existing task auctioneer + orchestrate-reactor route from here.

**Why append-only, not mutable payload.** T0 events are immutable by design (append-only ledger). Lifecycle progress is recorded by emitting NEW events (`task_draft_refining`, `task_draft_promoted`, etc.) that share the original draft's `payload_json.draft_id`. The refiner reconstructs current state by selecting the latest event per `draft_id`. Schema impact: enum extensions only; no new tables in Phase 1.

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

Any check → refiner emits `event_type: 'task_draft_stale'` with `payload_json: { draft_id, stale_reason: 'resolved_by_<commit_sha>' | 'duplicate_of_<task_id>' | 'path_removed' }`.

TTL backstop: drafts whose latest lifecycle event is `task_draft` and older than 14 days auto-stale with `stale_reason: 'ttl_expired'`. Drafts whose latest event is `task_draft_refining` and older than 30 days are treated as stuck — the refiner emits a fresh `task_draft_refining` (one retry) on the next tick; if still no terminal event 30 days later, auto-stale with `stale_reason: 'refining_stuck'`.

### 2.8 Cadence — cron-driven 15 min ticks

`schedule_cron: '*/15 * * * *'`. Per-tick budget: 5 drafts max. Predictable cost (~$0.05/day at granite-8b), proven home-mgmt pattern. Event-driven burst trigger deferred until evidence shows cron lag matters in practice.

## 3. Schema

### 3.1 Draft observation payload (memory_observe)

`memory_observe` takes an `event_type` + `payload_json` shape (see `packages/mcp/src/tools/observe.ts`). The filing call:

```json
{
  "ts": "<iso>",
  "source": "mcp",
  "event_type": "task_draft",
  "project_id": "<filer's current project>",
  "lane": "unknown",
  "payload_json": {
    "draft_id": "<uuid v4>",
    "prompt": "<one-paragraph description of the stumble + suggested next action>",
    "affects_projects": ["penumbra"],
    "evidence": {
      "conv_ids": ["conv-xxx"],
      "commits": ["abcdef1"],
      "files": ["packages/mcp/src/tools/chain-start.ts:78"],
      "session_id": "<session id>"
    },
    "auto_ok": false,
    "filed_by_agent": "<agent name>",
    "filed_via": "skill_inline" | "stop_hook",
    "parent_draft_id": null
  }
}
```

`draft_id` is the canonical identity carried by every later lifecycle event for this draft. `parent_draft_id` is non-null only when the filer is explicitly superseding a prior draft (rare; mostly used by the Stop-hook de-dup path).

### 3.2 Lifecycle as append-only events

Lifecycle progress is recorded by emitting NEW t0 events sharing the original draft's `payload_json.draft_id`. The refiner reconstructs current state by selecting the latest event per draft_id. No mutable fields, no new tables.

Lifecycle event types (each a new `event_type` enum variant):

| event_type | emitted by | payload additions |
|---|---|---|
| `task_draft` | filing agent | full draft (§3.1) |
| `task_draft_refining` | refiner at pick-up | `{ draft_id }` |
| `task_draft_promoted` | refiner on success | `{ draft_id, task_ids: [...] }` |
| `task_draft_stale` | refiner on stale fire | `{ draft_id, stale_reason: 'resolved_by_<sha>' | 'duplicate_of_<task_id>' | 'path_removed' | 'ttl_expired' }` |
| `task_draft_duplicate` | refiner when scope-overlap fires | `{ draft_id, duplicate_of_task_id }` |
| `task_draft_escalation` | refiner on budget exceed | `{ draft_id, escalation_reason }` |

"Pending drafts to refine" query: select the most recent event per draft_id; keep those whose latest type is `task_draft` or `task_draft_escalation` (the latter is for the escalation-tier refiner).

### 3.3 Produced tasks

Standard `FileTaskInput` rows. No new fields. The refiner sets `created_by_kind: 'agent'`, `created_by_id: 'task-refiner-<tier>'`, `origin: 'draft:<draft_id>'`. The forward link from draft to task is captured in `task_draft_promoted.payload_json.task_ids`; the reverse link from task to draft lives in `origin`.

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

System prompt (sketch): "You are the task refiner. Each tick: query `memory_search` for `event_type='task_draft'` events whose latest lifecycle event for the same `draft_id` is still `task_draft` (i.e., not yet refined or staled). For each such pending draft, emit `event_type='task_draft_refining'` (same draft_id), run staleness checks, and for survivors produce FileTaskInput payloads via `task_file`. Set `requires_review` to the negation of `payload_json.auto_ok`. On success emit `task_draft_promoted` with `task_ids: [...]`. On stale or duplicate, emit `task_draft_stale` or `task_draft_duplicate` with `stale_reason` / `duplicate_of_task_id`. When a draft exceeds your confident-output budget, emit `task_draft_escalation` instead of producing a task; the escalation tier will pick it up."

A sibling `task-refiner-escalation` agent (initial_agent: claude-acp-fast) ticks on the same cadence but only processes drafts whose latest event is `task_draft_escalation`.

## 5. Integration touchpoints

Two schemas must be extended in lockstep — `ObserveInputShape.event_type` gates inputs at the MCP boundary, `EventTypeSchema` gates storage. Skipping either rejects the filing call.

- `packages/mcp/src/tools/observe.ts` — extend `ObserveInputShape.event_type` to accept the six new variants (`task_draft`, `task_draft_refining`, `task_draft_promoted`, `task_draft_stale`, `task_draft_duplicate`, `task_draft_escalation`)
- `packages/core/src/schemas/event.ts` — extend `EventTypeSchema` with the same six variants
- `packages/core/src/tasks/schema.ts` — no changes; reuse `FileTaskInputSchema`
- `~/.config/agentchat/agentchat.yaml` — add the two long-lived agent definitions (primary already landed via this session; escalation is Phase 2)
- `plugin/skills/dispatching/SKILL.md`, `brainstorming/SKILL.md`, `maestro-context-prime/...`, `session-handoff/...` — add "stumble filing" sections
- `plugin/playbooks/session-summarize/playbook.yaml` (or new sibling) — add the Stop-hook extraction logic
- New: a small `dispatch-routing-guard`-style heuristic file at `packages/core/src/services/stumble-extractor.ts` for the Stop hook's transcript-scan logic
- No daemon code changes for Phase 1; the refiner uses existing MCP surface end-to-end

## 6. Phasing

### Phase 1 — Minimum viable discipline (ship-now)

1. Schema: extend `ObserveInputShape.event_type` (MCP boundary) AND `EventTypeSchema` (storage) with the six lifecycle variants in §3.2. Add round-trip tests through `memory_observe` for `task_draft` filing + lifecycle reconstruction (latest event per draft_id).
2. Skill instruction patches across the 4 named skills (file with the canonical payload from §3.1; emphasize `draft_id` is required and must be a fresh uuid).
3. `session-summarize` extension for Stop-hook extraction
4. `task-refiner-primary` long-lived agent definition (yaml + system prompt + initial working_memory) — already landed in `~/.config/agentchat/agentchat.yaml` via this session; needs system-prompt update once schema lockstep ships
5. Conservative gate only (`requires_review: !payload_json.auto_ok`)
6. Active staleness checks + TTL backstop, emitting append-only `task_draft_stale` events

Acceptance: at the end of one full day with skills + hook + refiner in place, the count of `task_draft` t0 events filed > 0, the count of `task_draft_promoted` events > 0, and at least one promoted task auto-dispatched (auto_ok path) without human intervention.

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
