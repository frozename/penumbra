# Penumbra-native skill plugin — phase out superpowers/* — Implementation Plan

Date: 2026-05-07
Brief: `docs/notes/maestro-continuation-2026-05-07-penumbra-skills.md` (committed `26b1f1f`)
Status: Ready
Audit: 7-day transcript scan run 2026-05-07 confirmed actively-invoked superpowers skills (counts in Phase 0 below); dormant skills are dropped without porting.

> **For agentic workers:** primary work is markdown skill files under `plugin/skills/<name>/SKILL.md`. The mem-search skill at `plugin/skills/mem-search/SKILL.md` is the canonical file shape. Skills auto-discover from this directory — no manifest churn.

## Pre-flight

- **Portability rule (binding for all skill bodies).** Skills ship with the penumbra plugin and run in *any* user project — not just this repo. Skill bodies MUST NOT reference penumbra-repo internals: no hardcoded `/Volumes/WorkSSD/...` paths, no `packages/<x>/...` imports, no `bun test` / `loadSqliteVec` / sqlite migration patterns, no language or test-framework assumption. Skills MAY assume penumbra primitives are reachable: MCP tools (`mcp__penumbra__chain_start`, `agent_recommend`, `memory_search`, `worktree_inspect`, `handoff_*`, etc.), the plan-runtime concept, the agentchat agent registry, the t2 memory corpus. Phase 0's loader/test code is repo-internal tooling and is exempt — it lives in `packages/core/` precisely because it's the validator that ships the skills.
- Skill file layout: `plugin/skills/<kebab-name>/SKILL.md` with YAML frontmatter (`name`, `description`). The `description` is what the harness pattern-matches against to auto-apply, so it must encode the trigger conditions in plain language. Penumbra's `plugin.json` already declares the plugin (`.claude-plugin/plugin.json`); skills are picked up by directory scan.
- Tests: skill bodies are prose, not code. Validation is meta — a small bun test that loads each `SKILL.md`, parses frontmatter, asserts presence of `name` + `description`, and (where applicable) checks that referenced MCP tool names actually exist in the agentchat manifest. Live `Skill` tool invocation is verified manually in Phase 5 via a smoke session.
- Daemon restarts: none required. Skills are read by the Claude Code harness at session start, not by the penumbra daemon.
- Style siblings: `plugin/skills/mem-search/SKILL.md` (file shape), `plugin/playbooks/{brainstorm,write-plan,session-handoff}/*.md` (delegate targets for thin ports).
- Neutral text, no AI/tool authorship. The `using-superpowers` replacement (`penumbra-skill-loader`) is the only meta auto-load skill — keep its body short and operational; do not import the superpowers prose verbatim.

## Audit (locked, 2026-05-07)

7-day `Skill` tool invocations under `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/`:

| superpowers skill | invocations | decision |
|---|---:|---|
| brainstorming | 6 | port — thin |
| writing-plans | 5 | port — thin |
| subagent-driven-development | 2 | port — merge into `dispatching` |
| using-superpowers | 1 | port — `penumbra-skill-loader` (meta) |
| systematic-debugging | 1 | port — penumbra-flavored as `dispatch-reliability-triage` |
| dispatching-parallel-agents | 1 | port — merge into `dispatching` |
| handoff (penumbra) | n/a (hook-driven) | port — thin |
| test-driven-development | 0 invocations | **port** — penumbra-flavored (user-prioritized; pairs with planning, enforces dispatch compliance) |
| executing-plans | 0 | drop (plan-runtime supersedes) |
| using-git-worktrees | 0 | drop (penumbra owns worktrees) |
| requesting-code-review / receiving-code-review | 0 / 0 | drop |
| finishing-a-development-branch | 0 | drop (reconciler is PR-mode; one-line memory reference suffices) |
| writing-skills | 0 | drop |
| verification-before-completion | 0 | drop (subsumed by net-new `worktree-state-audit`) |

## Dispatch graph (this plan, executed)

```
0.1
1.1 → 1.2
2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4
3.1 ∥ 3.2 ∥ 3.3
4.1 ∥ 4.2 ∥ 4.3 ∥ 4.4
5.1
```

Phase 0 audit-lock and infra (shipped in commit `ad23b16`). Phase 1: 1.1 meta loader → 1.2 playbook portability sweep. Phase 2 thin ports (parallel-safe; depend on 1.2 because they delegate to portable playbooks). Phase 3 substantive ports (real prose; parallel-safe by file). Phase 4 net-new (parallel-safe). Phase 5 switchover smoke.

---

## Phase 0 — Audit lock + skill-meta validator

Single task: ship the meta-validator harness so all later phases land green.

### Task 0.1 — Skill loader test + AGENTS.md surface inventory

```yaml meta
id: '0.1'
files:
  - packages/core/test/plugin/skill-meta.test.ts
  - packages/core/src/plugin/skill-meta.ts
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

Implement `packages/core/src/plugin/skill-meta.ts`:

- `loadSkillFiles(rootDir: string): Array<{name: string, description: string, body: string, path: string}>` — reads `plugin/skills/*/SKILL.md`, parses YAML frontmatter (use the same parser as `plugin/playbooks/*` loaders; do not pull a new dep), returns one entry per skill.
- Strict failure modes: missing frontmatter, missing `name` or `description`, frontmatter `name` not matching directory name → throw with the offending path.

**Tests** (`packages/core/test/plugin/skill-meta.test.ts`):
1. Loads the existing `mem-search` skill; returns one entry; asserts `name === 'mem-search'`.
2. A fixture skill with missing `description` → throws.
3. A fixture skill where directory name `foo-bar` mismatches frontmatter `name: foo` → throws.

Also: grep `AGENTS.md`, `CLAUDE.md`, `docs/notes/maestro-continuation-*` for explicit `superpowers:` references; capture findings in the commit message body so Phase 5 has the swap list ready. **Do not** edit those files yet.

**Commit:** `feat(plugin): skill-meta loader with frontmatter validation`

**Integration:** `bun test packages/core/test/plugin/skill-meta`. No daemon restart.

---

## Phase 1 — Meta loader skill (`penumbra-skill-loader`)

Replaces `superpowers:using-superpowers`. Auto-applies at session start. This phase ships alone because every later skill refers to it.

### Task 1.1 — `penumbra-skill-loader` skill

```yaml meta
id: '1.1'
files:
  - plugin/skills/penumbra-skill-loader/SKILL.md
file_scope: new
depends_on: ['0.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

Frontmatter `description` must include the phrase "Use when starting any conversation" so the harness's session-start matcher fires it.

Body covers, in operational tone (no rationalization frames, no red-flag tables):

1. How penumbra ships skills (this plugin) and where they live.
2. Trigger model — auto-apply on description match; explicit `Skill(<name>)` is also valid.
3. Priority order when multiple skills match: process skills (brainstorming, dispatch-reliability-triage) before implementation skills.
4. Penumbra-specific surface: `mcp__penumbra__memory_search`, `chain_start`, `agent_recommend`, `handoff_*`, plan-runtime.
5. User instructions (CLAUDE.md / AGENTS.md / direct request) override skill guidance — same hierarchy as superpowers.
6. One-line: "If superpowers:* is also installed, prefer the penumbra equivalent listed below," with a short table.

Keep total length < 120 lines.

**Tests:** included in 0.1 — the loader test now sees two skills (`mem-search`, `penumbra-skill-loader`) and both pass validation.

**Commit:** `feat(plugin/skills): penumbra-skill-loader — meta auto-load replacing superpowers:using-superpowers`

**Integration:** restart Claude Code session manually to confirm SessionStart hook surfaces the new skill in the available-skills list.

### Task 1.2 — Playbook portability sweep

```yaml meta
id: '1.2'
files:
  - plugin/playbooks/session-handoff/playbook.md
  - plugin/playbooks/maestro-context-prime/playbook.md
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Phase 2 thin ports delegate to these playbooks; the playbooks themselves must be portable before the skills can ship. Audit-confirmed bleed:

- `plugin/playbooks/session-handoff/playbook.md` line 62 hardcodes `/Volumes/WorkSSD/repos/personal/penumbra` in the handoff prompt template. Replace with `{{cwd}}` (or whatever the playbook templating context offers; if templating doesn't reach this string, replace with a runtime `process.cwd()` substitution at render time).
- Same file line 64 references `AGENTS.md` as if guaranteed to exist. Soften to "if `AGENTS.md` is present in the working repo" — keep the rest of the rule (use penumbra MCP, neutral commits, delegate via `chain_start`) since those are penumbra-runtime rules and apply universally.
- `plugin/playbooks/maestro-context-prime/playbook.md` line 33 — the "never query the live sqlite DB directly" rule is portable; leave as-is.

Sweep the rest of `plugin/playbooks/*/playbook.md` for the patterns flagged in the Pre-flight portability rule (`/Volumes/WorkSSD`, `packages/`, `bun test`, `loadSqliteVec`, `@penumbra/core`). Fix any other matches with the same approach.

**Tests:** lightweight grep-test at `packages/core/test/plugin/playbook-portability.test.ts` — for every `plugin/playbooks/*/playbook.md`, assert the file does not contain any of the banned patterns. Skip lines that are inside `<!-- portability-allow -->` comment blocks (escape hatch for genuinely-needed citations).

**Commit:** `fix(plugin/playbooks): make session-handoff and context-prime portable; add portability guard test`

**Integration:** `bun test packages/core/test/plugin/playbook-portability` passes. No daemon restart.

---

## Phase 2 — Thin ports (delegate-to-playbook)

Four skills, each ~30-60 lines. Frontmatter + 1-paragraph "this skill auto-applies the penumbra `<playbook>` playbook" body that names the slash command and lists trigger phrasing. The playbook owns the substantive process. Ordering inside the phase is unconstrained — different files, no cross-deps.

### Task 2.1 — `brainstorming` skill

```yaml meta
id: '2.1'
files:
  - plugin/skills/brainstorming/SKILL.md
file_scope: new
depends_on: ['1.2']
parallel_with: ['2.2', '2.3', '2.4']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

`description` covers: "Use before any creative work — designing features, deciding architecture, exploring requirements." Body delegates to `/brainstorm` (penumbra slash) and references `plugin/playbooks/brainstorm`. Mirrors the trigger semantics of `penumbra:brainstorming` — but the body is penumbra-flavored: pre-loaded specs + recall-prime are baked into the playbook, so the skill body can be terse.

**Commit:** `feat(plugin/skills): brainstorming — thin port over plugin/playbooks/brainstorm`

### Task 2.2 — `writing-plans` skill

```yaml meta
id: '2.2'
files:
  - plugin/skills/writing-plans/SKILL.md
file_scope: new
depends_on: ['1.2']
parallel_with: ['2.1', '2.3', '2.4']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

`description`: "Use when converting a spec or requirements into a phased TDD plan, before touching code." Body delegates to `/write-plan` and `plugin/playbooks/write-plan`. Calls out the `yaml meta` block convention, plan-validator (`bun packages/cli/bin/penumbra.ts plan validate`), and that plans live in `docs/superpowers/plans/`.

**Commit:** `feat(plugin/skills): writing-plans — thin port over plugin/playbooks/write-plan`

### Task 2.3 — `handoff` skill

```yaml meta
id: '2.3'
files:
  - plugin/skills/handoff/SKILL.md
file_scope: new
depends_on: ['1.2']
parallel_with: ['2.1', '2.2', '2.4']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

`description`: "Use at end of session, on PreCompact, or when explicitly asked to hand off — captures recent state, dispatch outcomes, pending work." Body delegates to `/handoff` and `plugin/playbooks/session-handoff`. Notes that PreCompact/Stop hooks already trigger this — so the skill is mostly a fallback for explicit invocation.

**Commit:** `feat(plugin/skills): handoff — thin port over plugin/playbooks/session-handoff`

### Task 2.4 — `mem-search` skill description tightening

```yaml meta
id: '2.4'
files:
  - plugin/skills/mem-search/SKILL.md
file_scope: modify-existing
depends_on: ['1.2']
parallel_with: ['2.1', '2.2', '2.3']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

The existing `mem-search` skill uses `memory.search` style; the live MCP surface is `mcp__penumbra__memory_search` / `mcp__penumbra__memory_timeline` / `mcp__penumbra__memory_get_observations`. Update the body to match the actual tool names so cold dispatches don't miss. Keep the 3-layer workflow text intact. Tighten the `description` to include "Use when answering 'did we already solve this' or 'how did we do X last time'" so auto-match fires.

**Commit:** `fix(plugin/skills/mem-search): align tool names with live MCP surface`

**Integration for Phase 2:** `bun test packages/core/test/plugin/skill-meta` (now sees 5 skills). Manual: open a fresh session, type `/brainstorm` and confirm the playbook fires.

---

## Phase 3 — Substantive ports

Three skills with real prose bodies that encode penumbra-specific heuristics. Each parallel-safe by file.

### Task 3.1 — `dispatching` skill (merged subagent-driven + parallel)

```yaml meta
id: '3.1'
files:
  - plugin/skills/dispatching/SKILL.md
file_scope: new
depends_on: ['1.1']
parallel_with: ['3.2', '3.3']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: substantial
risk_class: paste-ready
```

`description`: "Use when about to dispatch coding work to an agent — chain_start, agent selection, parallelism rules, and bounds setting. Replaces penumbra:dispatching and penumbra:dispatching."

Body sections:

1. **When to dispatch vs hand-code** — penumbra rule: maestro is the orchestrator; hand-code only when the worker/daemon won't boot. Cite `feedback_delegate_dont_implement.md`.
2. **Pre-dispatch checklist**: `mcp__penumbra__agent_recommend` → top candidate; verify the agent is `maestro_capable` in agentchat.yaml; consult recent ledger health (cite `feedback_dispatch_reliability_workarounds.md`).
3. **chain_start contract** — required fields, branch_base plumbing reminder (`project_plan_runtime_branch_base.md`), use_worktree, prompt-only-coding-no-restart-of-host-worker (`feedback_dont_make_agents_kill_their_host_worker.md`).
4. **Parallelism rules** — independent tasks only; do NOT fan-out fix loops (`feedback_sequential_rollout_no_dispatch_loops.md`); prefer single implementer per task.
5. **Don't-do list** — no commits to main while dispatch in flight (`feedback_dont_commit_to_main_during_dispatch.md`); chat-only agents need inlined content (`feedback_chat_only_agents_inline_context.md`); cheap models hallucinate audits (`feedback_cheap_models_hallucinate_audits.md`).

**Commit:** `feat(plugin/skills): dispatching — chain_start + agent_recommend + parallelism playbook`

### Task 3.2 — `test-driven-development` skill (penumbra-flavored)

```yaml meta
id: '3.2'
files:
  - plugin/skills/test-driven-development/SKILL.md
file_scope: new
depends_on: ['1.1']
parallel_with: ['3.1', '3.3']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: substantial
risk_class: paste-ready
```

`description`: "Use when implementing any feature or bugfix — write the smallest failing test first, then make it pass. Pairs with writing-plans and chain_start dispatches: the failing test becomes the dispatch contract."

Body sections (framework-agnostic — auto-detect the user's test stack from the project; do NOT name a specific test runner):

1. **Why TDD pairs with penumbra dispatch.** The failing test is the spec. Without it, a dispatched agent has only prose to interpret and tends to drift. With it, the agent has a binary signal — and the reviewer agent (or you) has an unambiguous merge gate. This is the compliance layer that makes agent-driven development trustworthy.
2. **Smallest failing test first.** Start at the unit boundary closest to the change. One assertion is fine. Resist scope creep into integration tests until the unit is green.
3. **Detect the test stack.** Before writing the test, look for project conventions: `package.json#scripts.test`, `pyproject.toml`, `go.mod`, `Cargo.toml`, existing `*test*` files. Mirror the project's existing test framework, layout, and assertion style. Do NOT introduce a new test runner.
4. **Real behavior, not pattern-matching.** Assertions must check actual outcomes — content, return values, side effects — not strings the implementation could fake to pass. If the test would pass against a stub that just echoes the expected value, the test isn't strong enough.
5. **Focused loop.** Run only the affected test(s) while iterating. Full project typecheck/lint at commit-time only. Don't let unrelated repo-wide failures block the focused commit; stage only the files you intentionally changed.
6. **For dispatched implementations** (this is the penumbra-specific value-add):
   - Write the failing test first, locally or in the dispatch prompt as a literal block.
   - In the `chain_start` `message`, include: the test file path, the failing test body verbatim, the command to run *just that test*, and an explicit "do not modify the test; make the implementation pass it" instruction.
   - For substantial changes, dispatch a separate reviewer agent (via `mcp__penumbra__agent_recommend(task_type="review_adversarial")`) that re-runs the test pre/post and reports green/red. Treat red as "do not merge."
7. **Common traps** (cite memories so future sessions can recall):
   - Synthetic-pattern assertions that pass against a stub. (Memory: `Trap: Initial Worktree Test Idea Inadequate`.)
   - Schema-layer change without the corresponding storage-layer update. (Memory: `Trap: Schema Layer vs. Actual Table Mismatch`.)
   - Staging unrelated typecheck artifacts or lockfile noise alongside the focused commit. (Memory: `User Preference: Stage Only Intended Source and Test Edits`.)

**Commit:** `feat(plugin/skills): test-driven-development — failing-test-first discipline with chain_start dispatch contract`

### Task 3.3 — `dispatch-reliability-triage` skill (replaces systematic-debugging)

```yaml meta
id: '3.3'
files:
  - plugin/skills/dispatch-reliability-triage/SKILL.md
file_scope: new
depends_on: ['1.1']
parallel_with: ['3.1', '3.2']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: substantial
risk_class: paste-ready
```

`description`: "Use when a dispatch fails or returns suspicious output — classify the failure (transport-closed / cost-cap / prompt-injection-refused / parse-fail / cosmetic-tool_failure / silent-success-no-commit) and skip retry if structural."

Body taxonomy (each entry: symptom → root cause → mitigation, citing the exact memory note):

- transport-closed / 60s timeout → `project_acp_watchdog_fix.md` (mostly fixed)
- codex-acp helper crash → `project_codex_acp_feature_flags.md`
- gemini replace-and-quit → `project_acp_failure_modes.md`
- claude-acp-sonnet refuses dispatches as prompt injection → `feedback_dispatch_reliability_workarounds.md`
- codex-acp `tool_failure_with_end_turn` cosmetic → same memory; verify worktree state before retrying
- ok+worktree_changed but no commit → `project_codex_acp_non_commit.md`; recover from `/Volumes/WorkSSD/repos/penumbra-worktrees/<id>/`
- transport-closed wedged child → `project_codex_acp_memory_leak.md`
- chat-only agent silent fail → `feedback_chat_only_agents_inline_context.md`
- bun ONNX teardown panic → cosmetic, ignore
- HTTP 400 after schema change → `feedback_daemon_restart_on_schema_change.md`

Closing rule: classify before retrying. Structural failures (codesigning crashes, missing maestro_capable flags) re-fire the same way; transient failures (memory pressure, watchdog) are worth one retry on a different agent from `agent_recommend`.

**Commit:** `feat(plugin/skills): dispatch-reliability-triage — failure taxonomy with memory citations`

**Integration for Phase 3:** `bun test packages/core/test/plugin/skill-meta` (now sees 8 skills). Manual smoke deferred to Phase 5.

---

## Phase 4 — Net-new highest-leverage

Four skills that exist *because of* penumbra surface — recall corpus, agent ledger, worktree audit, session-start hooks. Parallel-safe by file.

### Task 4.1 — `maestro-recall-prime` skill

```yaml meta
id: '4.1'
files:
  - plugin/skills/maestro-recall-prime/SKILL.md
file_scope: new
depends_on: ['1.1']
parallel_with: ['4.2', '4.3', '4.4']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

`description`: "Use before any non-trivial action in penumbra — surface 3-5 most-relevant t2 memories via `mcp__penumbra__memory_search` to avoid re-deriving solved problems."

Body: workflow is search → optional timeline → use the IDs in subsequent reasoning. Reuses the 3-layer pattern from `mem-search` but framed as a pre-action prime, not a "did we solve this" lookup. Cite `feedback_delegate_dont_implement.md` and the brief.

**Commit:** `feat(plugin/skills): maestro-recall-prime — pre-action t2 memory prime`

### Task 4.2 — `agent-pick-via-ledger` skill

```yaml meta
id: '4.2'
files:
  - plugin/skills/agent-pick-via-ledger/SKILL.md
file_scope: new
depends_on: ['1.1']
parallel_with: ['4.1', '4.3', '4.4']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

`description`: "Use before chain_start when picking an agent — call `mcp__penumbra__agent_recommend(task_type)` and prefer the top-ranked candidate with confidence + last-observed timestamp."

Body: the `agent_recommend` contract, what the confidence band means, how to fall back when the top candidate is in a known-bad window (cite `agentchat_local_model_calibration.md`, `project_codex_acp_memory_leak.md`). Mention `agent_rank` for deeper inspection.

**Commit:** `feat(plugin/skills): agent-pick-via-ledger — agent_recommend gate before dispatch`

### Task 4.3 — `worktree-state-audit` skill

```yaml meta
id: '4.3'
files:
  - plugin/skills/worktree-state-audit/SKILL.md
file_scope: new
depends_on: ['1.1']
parallel_with: ['4.1', '4.2', '4.4']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

`description`: "Use after any chain_start that returned success and before merging the agent branch — verify the worktree state (git log, diff, status) actually matches what the prompt asked for."

Body (replaces penumbra:verification-before-completion). Penumbra-mediated, environment-agnostic — never hardcode worktree paths:

1. **Why this skill exists.** Agents sometimes report failure when work landed (cosmetic `tool_failure_with_end_turn`) and sometimes report success when nothing was committed. Trust the worktree, not the agent's self-report.
2. **Workflow:**
   - `mcp__penumbra__handoff_get(handoff_id, compact=true)` → confirms terminal status and surfaces the `worker_id` and any error_message.
   - `mcp__penumbra__worktree_inspect(handoff_id)` → returns the worktree path and the agent branch name (penumbra owns the path layout; do not assume any specific filesystem location).
   - `git -C <worktree-path> log --oneline -10` → expected commits present?
   - `git -C <worktree-path> diff main...HEAD --stat` → file surface matches the prompt's intended surface area?
   - `git -C <worktree-path> status` → no uncommitted leftovers? If there are, the dispatch left work behind.
3. **Decision matrix:**
   - Commit landed + diff matches prompt scope → safe to FF-merge.
   - Commit landed + diff includes unrelated files → ask before merging; agent may have over-reached.
   - No commit + worktree dirty → recover with `git -C <worktree> add -A && git -C <worktree> commit -m "<reconstructed>"` only if the diff content is clearly the intended work; otherwise re-dispatch.
   - No commit + clean worktree → silent failure; re-dispatch with sharper prompt.
4. **Memories to recall on edge cases:** `feedback_dispatch_reliability_workarounds.md`, `project_codex_acp_non_commit.md`.

**Commit:** `feat(plugin/skills): worktree-state-audit — post-dispatch verification loop`

### Task 4.4 — `session-fast-context` skill

```yaml meta
id: '4.4'
files:
  - plugin/skills/session-fast-context/SKILL.md
file_scope: new
depends_on: ['1.1']
parallel_with: ['4.1', '4.2', '4.3']
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

`description`: "Use at session start before answering anything — load most recent `maestro-continuation-*` note, last 5 commits, `handoff_list_pending`, and 3-5 recall hits relevant to the user's first message."

Body: the operational sequence; calls out that `plugin/playbooks/maestro-context-prime` already does the heavy lifting and this skill is the trigger surface. Cite the brief.

**Commit:** `feat(plugin/skills): session-fast-context — auto-prime session context from recent notes + recall`

**Integration for Phase 4:** `bun test packages/core/test/plugin/skill-meta` (now sees 12 skills total).

---

## Phase 5 — Switchover smoke + AGENTS.md update

Single task, hand-run by maestro (not dispatched).

### Task 5.1 — Smoke session + doc swap

```yaml meta
id: '5.1'
files:
  - AGENTS.md
  - CLAUDE.md
file_scope: modify-existing
depends_on: ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '4.1', '4.2', '4.3', '4.4']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp
task_size: small
risk_class: paste-ready
```

1. Open a fresh Claude Code session in this repo with the superpowers plugin still installed (do NOT uninstall yet).
2. Confirm the new penumbra skills appear in the available-skills list at session start.
3. Run a small end-to-end exercise: `/brainstorm` → `/write-plan` (small fictional spec) → file an `kind=orchestrate` task → `/handoff`. Watch the harness pick the penumbra skill over the superpowers equivalent (description match priority is harness-internal; verify by transcript inspection).
4. If a superpowers skill still wins on a tie, tighten the penumbra `description` until it matches first.
5. Update `AGENTS.md` and any `docs/notes/maestro-continuation-*` references that name `superpowers:*` skills explicitly to point at the penumbra equivalents.
6. Land in one commit: `docs: switch maestro flow references from superpowers/* to penumbra plugin skills`.
7. Defer the actual `superpowers/` plugin uninstall to a follow-up session — leave it installed but unused for at least one full work-day to catch any missed call-sites.

**Commit:** `docs: switch maestro flow references from superpowers/* to penumbra plugin skills`

**Integration:** none beyond the smoke session itself.

---

## Backlog (deferred, V2 of this work)

From the brief, lower-leverage net-new skills to ship later, one at a time, as the underlying plumbing settles:

- `workload-health-check` (llamactl gate)
- `plan-runtime-aware` (warn on plan edits while plan-runtime active)
- `cost-budget-awareness` (bounds-tracker p50 hints)
- `incident-postmortem` (auto-prompt t2 write after a fix)
- `t2-promotion-debug` (judge-pool diagnostic flow)
- `knowledge-distillation-trigger` (consolidate after N memories)
- `cross-judge-verification` (V3 dual-judge writes)

Plus the actual superpowers plugin uninstall (Phase 6 of this initiative — calendar follow-up).
