# Penumbra superpowers fork — design

> Status: draft for user review. Inputs to `/write-plan`.

## Background

The `superpowers@claude-plugins-official` plugin (currently installed at v5.1.0) ships rich process-discipline skills: `brainstorming`, `writing-plans`, `test-driven-development`, `verification-before-completion`, `systematic-debugging`, code-review pair, and several others. Earlier commits (`d3f4527`, `517b626`, `52fa766`, follow-up `4b58b8d`) ported `brainstorming`, `writing-plans`, and a few others into the local `penumbra` plugin at `plugin/skills/<name>/SKILL.md` + `plugin/playbooks/<name>/playbook.md`. Those ports were "thin" — they kept the recall pre-load mechanism (`memory.search` + `fs.glob`) and the slash-trigger plumbing but **stripped the process discipline content** down to a 30-line shim that says "follow `brainstorming`". The HARD-GATE block, 8-step checklist, process digraph, anti-pattern callout, spec self-review checklist, "No Placeholders" anti-patterns, TDD step examples, and most other discipline content were dropped.

Concrete loss measurements:
- `superpowers:brainstorming` upstream SKILL.md = 165 lines of process content.
  Local `plugin/skills/brainstorming/SKILL.md` = 33-line shim.
- `superpowers:writing-plans` upstream SKILL.md = 153 lines.
  Local `plugin/skills/writing-plans/SKILL.md` = 37-line shim.

This session also surfaced a concrete failure mode: a brainstorm-and-eval-plan workflow at `docs/notes/eval-plan-chain-start-prompt-refining.md` was drafted against a primary metric (`gate_outcome=passed`) that had zero variance (48/0/0 distribution). A 30-second SQL query before drafting would have killed the plan; no such gate existed in either the local or upstream brainstorming skill.

## Goal

Build a real fork of the relevant upstream superpowers skills inside the existing `penumbra` plugin, so that:

1. The full upstream process-discipline content is restored.
2. The penumbra-native additions (yaml-meta blocks, dispatch graphs, agent_recommend wiring, plan-runtime hooks, memory recall) are preserved.
3. High-value upstream-only skills are adopted into the local plugin.
4. A new "measurement classification" hard gate is added to brainstorming (and a short reference is added to writing-plans).
5. After validation, the upstream `superpowers@claude-plugins-official` plugin is uninstalled so there is no namespace ambiguity.

Out of scope: rewriting the local skill loader (`plugin/skills/penumbra-skill-loader/`), changing the playbook recall mechanism, changing the slash-command bindings, or PR-ing changes back to `anthropics/claude-plugins-official`.

## Architecture

### Plugin home

Inside the existing `penumbra` plugin (declared in `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`, version `0.1.0`, source `./plugin`). No marketplace surgery. No sibling plugin. No new repo.

### Per-skill file structure

For every overlapping and adopted skill:

- **`plugin/skills/<name>/SKILL.md`** — the rich body. Contains the full upstream
  process content merged with penumbra-native additions and integration notes.
  Targets ~120–220 lines depending on skill. This is visible at session-start
  via the plugin loader; agents read it without needing to invoke the slash.

- **`plugin/playbooks/<name>/playbook.md`** — short recall template (~30–40
  lines). Contains `triggers`, `recall` (memory.search + fs.glob), and a
  markdown template that says "follow `<skill>` skill, recall results
  pre-loaded above." Triggered by `/<slash>` command. Stays minimal because
  the discipline content now lives in SKILL.md.

For adopted upstream-only skills (verification-before-completion etc.), a
playbook is only added if recall pre-load adds value. Most adopted skills
will be SKILL.md only.

### Frontmatter contract

SKILL.md frontmatter mirrors the existing local pattern:

```yaml
---
name: <skill-name>
description: <one-line summary used by skill priority>
---
```

Playbook frontmatter mirrors existing pattern (triggers + recall + output + run).

The penumbra-skill-loader handles registration; this design does not touch
the loader.

## Skill inventory

### Group A — Overlapping skills (3): restore + augment

For each, merge upstream's full body into local SKILL.md, preserve all
penumbra-native additions, then commit per lane with adversarial review.

1. **`brainstorming`** —
   - Restore upstream: HARD-GATE block, 8-step checklist, process digraph,
     anti-pattern callout ("This Is Too Simple To Need A Design"),
     scope-check / decomposition guidance, multiple-choice question
     preference, design-for-isolation principles, existing-codebases
     guidance, spec self-review checklist, user review gate, transition
     to implementation rules.
   - Preserve local: pre-loading of `docs/superpowers/specs/*` + brainstorm
     memory recall via the slash command and playbook.
   - Add new: **measurement-classification hard gate** (see Section "Variance
     Gate" below).
   - Defer: visual-companion section is optional; if included, link to
     existing `plugin/playbooks/brainstorm/visual-companion.md` if present
     (audit during implementation).

2. **`writing-plans`** —
   - Restore upstream: bite-sized TDD step examples (write test → run → impl →
     run → commit), plan document header template, task structure example
     with explicit checklist syntax, "No Placeholders" anti-pattern list,
     self-review (spec coverage / placeholder scan / type consistency),
     execution handoff (subagent-driven vs inline).
   - Preserve local: per-task `yaml meta` block schema, per-phase dispatch
     graphs, integration notes per phase, `penumbra plan validate` gate,
     `agent_recommend` wiring guidance, `chain.list_agents` registry check.
   - Add new: short variance-gate reference ("if this plan involves a
     measurement / comparison metric, the spec must include a variance
     sanity-check result").

3. **`test-driven-development`** —
   - Audit current local content (commits `cd73d26` / `35738af`) before
     designing the merge. The local TDD skill predates this session; need
     to read it and decide whether to absorb upstream's TDD content or keep
     the local version as canonical.
   - Likely merge: upstream's TDD discipline (write failing test first, run
     and observe failure, minimal impl, run, commit) with our chain_start
     dispatch contract (chat-only agents can't run tests, so explicit
     "run tests in worktree before claim pass" gate).

### Group B — Upstream-only adopted skills (7)

For each, port upstream SKILL.md content into `plugin/skills/<name>/SKILL.md`
with a penumbra integration note where applicable.

4. **`verification-before-completion`** — evidence-before-assertions:
   require running verification commands and quoting output before claiming
   work complete. No integration note needed; generic discipline.

5. **`systematic-debugging`** — reproduce → isolate → hypothesize → verify.
   No integration note needed.

6. **`receiving-code-review`** — verify feedback claims before implementing;
   require technical rigor, not blind compliance. Integration note: adversarial-review
   syntheses count as code review for this purpose.

7. **`requesting-code-review`** — use when completing tasks, implementing
   major features, or before merging. Integration note: in penumbra,
   adversarial-review is the canonical code review path; this skill should
   reference our `adversarial-review` skill for invocation.

8. **`writing-skills`** — meta-skill for creating new skills with proper
   frontmatter, examples, verification. Integration note: penumbra plugin
   skills live at `plugin/skills/<name>/SKILL.md` and may have a paired
   playbook at `plugin/playbooks/<name>/playbook.md`.

9. **`executing-plans`** — batch execution with checkpoints. Integration
   note: in penumbra, plans authored via `/write-plan` are typically
   dispatched via plan-runtime, not executed inline by a maestro. This
   skill applies when a plan is being executed in the current session
   (rare) rather than dispatched as orchestrate tasks.

10. **`finishing-a-development-branch`** — choose merge / PR / cleanup after
    completion. Integration note: in penumbra, agent branches are
    integrated via `dispatch_land` (which re-stamps `agent_performance.outcome`);
    hand-merges from the home checkout bypass attribution and are
    discouraged.

### Group C — Upstream skills NOT adopted (4)

- `using-superpowers` — superseded by `penumbra-skill-loader` (commit `e8f6912`).
- `using-git-worktrees` — penumbra MCP `worktree_*` tools + the local
  `worktree-state-audit` skill cover this; upstream's manual git-worktree
  workflow conflicts with our managed worktree model.
- `subagent-driven-development` — assumes Task()-subagent model; penumbra's
  canonical pattern is `chain_start` dispatch. Adopting this would
  fork the team's mental model.
- `dispatching-parallel-agents` — same reason. The local `dispatching`
  skill (commit `42d83f4`) is the canonical chain_start-aware version.

### Group D — Local-only skills (kept as-is)

No content change in this design. Listed for completeness:

- `agent-pick-via-ledger`, `dispatch-reliability-triage`, `handoff`,
  `maestro-recall-prime`, `mem-search`, `penumbra-skill-loader`,
  `session-fast-context`, `worktree-state-audit`, `dispatching`.

Playbook-only entries also kept as-is:
- `delegate-suggest`, `file-context`, `prompt-classify`, `session-summarize`.

## Variance gate (full text)

Inserted into `brainstorming` SKILL.md between "Explore project context"
and "Ask clarifying questions" in the checklist. Numbered as Step 1.5 so
the existing numbering stays stable. Render verbatim:

```markdown
### Step 1.5: Measurement classification (HARD GATE)

Before proposing approaches, verbalize one of:

A) **Not a measurement task.** This work is building / refactoring /
   fixing without a metric-comparison or eval question. State this
   explicitly, then proceed to clarifying questions.

B) **This work involves measuring, comparing, or evaluating something
   via a metric.** Before drafting any approach:

   1. Identify the primary metric. Be specific — `table.column`,
      computed expression, or operational definition. Vague targets
      ("quality", "performance") are not yet metrics.

   2. Run a variance / distribution query on the existing data source.
      Quote the result verbatim. Examples:
      - SQL: `SELECT <metric>, COUNT(*) FROM <source> GROUP BY <metric>`
      - Code metric: read the column, plot distribution, report
        unique-value count.
      - External system: pull recent N data points, report distribution.

   3. Decide based on the result:
      - **Zero variance** (all rows equal value): the eval is
        unmeasurable as posed. STOP. Reshape the question before
        drafting any approach.
      - **Tiny variance** (e.g., 95% one value): flag the imbalance.
        Consider whether the imbalance itself is the actual question.
      - **Healthy variance**: proceed to clarifying questions.

Why this gate exists: an eval-plan drafted earlier in penumbra's history
proposed measuring lane outcomes via `gate_outcome=passed`, which had
zero variance (48 of 48 closed lanes were passed). A 30-second SQL
query before drafting would have killed the plan. The cost of this
gate is one classification line in the brainstorm transcript per
session; the savings is avoiding unmeasurable evals.
```

In `writing-plans` SKILL.md, a shorter reference is inserted near the
top of the "Self-Review" section:

```markdown
**0. Measurement gate (if applicable):** If this plan involves measuring,
comparing, or evaluating something via a metric, the input spec MUST
include a variance / distribution query result for the primary metric.
If absent, return to brainstorming (this gate exists because evals
without variance are unmeasurable; see `brainstorming` Step 1.5).
```

## Migration plan (high-level — `/write-plan` produces the detailed version)

**Phase 0 — Pre-work audit (1 dispatch).**
Delegate a structured diff: for each of `brainstorming`, `writing-plans`,
`test-driven-development`, produce a 3-column report — upstream paragraph,
local content, merge verdict (`keep_upstream`, `keep_local`, `merge`).
Output written to `docs/notes/superpowers-fork-audit-2026-05-14.md`.
This audit is the spec input for Phase 1.

**Phase 1 — Overlap restoration (3 lanes, sequential).**
- Lane 1a: `brainstorming` (incl. variance gate Step 1.5).
- Lane 1b: `writing-plans` (incl. variance reference + yaml meta + dispatch graph).
- Lane 1c: `test-driven-development`.
Each lane: implement → adversarial review by different agent → lane_close
with `metadata_json`.

**Phase 2 — Upstream adoption (7 skills, can run in parallel-of-2 or sequential).**
Port `verification-before-completion`, `systematic-debugging`,
`receiving-code-review`, `requesting-code-review`, `writing-skills`,
`executing-plans`, `finishing-a-development-branch`. Each with the
integration notes described in Group B above.

**Phase 3 — Validation + switchover (manual + 1 verification dispatch).**
- Restart Claude Code session to reload plugin.
- For each ported skill, invoke `Skill(<name>)` and confirm the body
  loads (sample five at random; verify with full body length sanity check).
- Grep repo for references to `superpowers:*` skill names; update or
  document intentional references.
- Run `claude /plugin uninstall superpowers@claude-plugins-official`.
- Verification dispatch: confirm `Skill(brainstorming)` still resolves
  to penumbra version, not "skill not found".

**Phase 4 — Docs + closeout.**
- Update `AGENTS.md` if it references upstream superpowers.
- Save a memory entry noting the fork is canonical and the variance gate.
- Optional: retire stale MEMORY.md entries about thin ports.

Total scope estimate: 3–5 hours across the four phases.
BOUNDARY-class change (affects every future coding session). Each lane
runs through `dispatch-quality-gates` per the standard discipline.

## Testing / verification strategy

There is no executable test suite for skill content. Verification is
prose-quality + behavioral:

- **Per-skill prose review (adversarial-review):** each ported SKILL.md
  goes through one round of adversarial-review by a different agent
  than the implementer. Reviewer checks: upstream content faithfully
  preserved, penumbra additions consistent with current code paths,
  integration notes accurate, frontmatter valid.

- **Behavioral smoke (Phase 3 validation):** invoke each ported skill
  via `Skill(<name>)` and confirm the body loads with expected line
  count and section headings.

- **End-to-end smoke (Phase 4):** run `/brainstorm` in a scratch session
  for a hypothetical eval task; verify the variance gate fires and the
  brainstorm refuses to proceed past Step 1.5 until classification is
  verbalized.

## Open implementation questions (resolved during `/write-plan`)

- Exact line count to target per SKILL.md (upstream ranges 70–165;
  local additions may push some past 200).
- Whether to inline upstream's referenced sub-files (e.g., visual-companion
  for brainstorming) or link to existing local copies.
- Naming format the loader produces — bare `brainstorming` vs
  `penumbra:brainstorming`. Verify during Phase 3 validation; if loader
  produces the prefixed form, no name collision risk during the
  parallel-installed validation window.

## Success criteria

1. Every overlapping skill's SKILL.md contains both the upstream
   process body and the penumbra-native additions, verified by
   adversarial review.
2. The variance gate fires on a synthetic eval brainstorm and
   blocks drafting until classified.
3. Seven new SKILL.md files exist in `plugin/skills/` for the adopted
   upstream skills.
4. `superpowers@claude-plugins-official` is uninstalled.
5. No broken references to `superpowers:*` in the repo (or each
   remaining reference is documented as intentional).
6. `AGENTS.md` and MEMORY.md reflect the new canonical source.
