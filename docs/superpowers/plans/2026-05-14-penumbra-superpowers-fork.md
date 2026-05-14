# Penumbra superpowers fork — implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` (after Phase 1 lands; before then it does not exist locally with rich content) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restore upstream `superpowers` process-discipline content into the local `penumbra` plugin, adopt 7 upstream-only skills, add a measurement-classification hard gate to brainstorming, then uninstall `superpowers@claude-plugins-official`.

**Architecture:** Each overlapping skill gets a rich `plugin/skills/<name>/SKILL.md` (full upstream body + penumbra additions) and keeps a thin `plugin/playbooks/<name>/playbook.md` for `/<slash>` recall. Adopted skills are SKILL.md-only. After validation, the upstream plugin is uninstalled; no parallel-installed window left open.

**Tech Stack:** Markdown only. No code. No tests. Verification is adversarial-review on each lane + behavioral smoke after switchover.

**Spec:** [docs/superpowers/specs/2026-05-14-penumbra-superpowers-fork-design.md](../specs/2026-05-14-penumbra-superpowers-fork-design.md)


## Phase 0 — Audit

Dispatch graph: 0.1

### Task 0.1: Structured diff audit (brainstorming, writing-plans, TDD)

```yaml meta
id: '0.1'
files:
  - docs/notes/superpowers-fork-audit-2026-05-14.md
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `docs/notes/superpowers-fork-audit-2026-05-14.md`
- Read (upstream): `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/SKILL.md`
- Read (upstream): `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/writing-plans/SKILL.md`
- Read (upstream): `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/test-driven-development/SKILL.md`
- Read (local): `plugin/skills/brainstorming/SKILL.md`
- Read (local): `plugin/skills/writing-plans/SKILL.md`
- Read (local): `plugin/skills/test-driven-development/SKILL.md`
- Read (local): `plugin/playbooks/brainstorm/playbook.md`
- Read (local): `plugin/playbooks/write-plan/playbook.md`

- [ ] **Step 1: Read all six SKILL.md files and two playbook.md files**

- [ ] **Step 2: Produce a 3-column diff per skill in a markdown table**

For each of `brainstorming`, `writing-plans`, `test-driven-development`, produce a section like:

```markdown
## brainstorming

| Upstream paragraph / section | Local equivalent | Verdict |
|---|---|---|
| HARD-GATE block (lines 12–14) | absent | KEEP upstream |
| Anti-Pattern: "Too Simple" (lines 16–18) | absent | KEEP upstream |
| 8-step checklist (lines 22–33) | absent | KEEP upstream |
| Process digraph (lines 36–64) | absent | KEEP upstream |
| Visual companion section (lines 147–164) | absent; sub-file `visual-companion.md` referenced | KEEP upstream + audit sub-file |
| (penumbra addition) recall pre-load of specs + memory | present in playbook | KEEP local |
| (penumbra addition) /brainstorm slash trigger | present in playbook | KEEP local |
| ... | ... | ... |
```

Cover every paragraph; "Verdict" is one of `keep_upstream` / `keep_local` / `merge` / `drop`.

- [ ] **Step 3: List visual-companion sub-files referenced by upstream brainstorming**

Note whether `visual-companion.md` exists upstream and whether a copy or analog exists in `plugin/playbooks/brainstorm/` or `plugin/skills/brainstorming/`. Flag for Phase 1.1 to decide inline vs link.

- [ ] **Step 4: Write the audit file**

Save as `docs/notes/superpowers-fork-audit-2026-05-14.md`. Include a one-paragraph summary at top: "This audit is the input spec for Phase 1 of the superpowers fork plan."

- [ ] **Step 5: Commit**

```bash
git add docs/notes/superpowers-fork-audit-2026-05-14.md
git commit -m "docs(notes): superpowers fork audit — upstream-vs-local per-paragraph diff for brainstorming, writing-plans, TDD"
```

Integration: cherry-pick lands the audit note on main; no functional change, no smoke needed. The audit is read input for Phase 1.


## Phase 1 — Overlap restoration

Dispatch graph: 1.1 → 1.2 → 1.3

Sequential, not parallel, so each lane can build on conventions established by the prior one (file structure, frontmatter, integration-note style).

### Task 1.1: Restore `brainstorming` SKILL.md + add variance-gate Step 1.5

```yaml meta
id: '1.1'
files:
  - plugin/skills/brainstorming/SKILL.md
file_scope: modify-existing
depends_on: ['0.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: substantial
risk_class: paste-ready
```

**Files:**
- Modify: `plugin/skills/brainstorming/SKILL.md`
- Read (audit): `docs/notes/superpowers-fork-audit-2026-05-14.md`
- Read (upstream): `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/SKILL.md`
- Read (spec): `docs/superpowers/specs/2026-05-14-penumbra-superpowers-fork-design.md` — variance gate full text

- [ ] **Step 1: Read the audit file + spec variance gate section**

- [ ] **Step 2: Compose the merged SKILL.md**

Structure (top to bottom):

1. Frontmatter — keep current `name: brainstorming` and refine the `description` to be one specific line about pre-loaded recall + discipline.
2. `# Brainstorming Ideas Into Designs` heading.
3. Upstream's `<HARD-GATE>` block — verbatim.
4. Upstream's "Anti-Pattern: This Is Too Simple To Need A Design" — verbatim.
5. Upstream's `## Checklist` with 8 items, BUT renumbered/inserted as below (variance gate becomes Step 1.5; subsequent step numbers unchanged):
   1. Explore project context
   1.5. **Measurement classification (HARD GATE)** — paste the variance gate full text from the spec
   2. Offer visual companion (if applicable; if `plugin/playbooks/brainstorm/visual-companion.md` does not exist, drop this step or note as "Not available in penumbra plugin yet" — depends on audit verdict)
   3. Ask clarifying questions
   4. Propose 2-3 approaches
   5. Present design
   6. Write design doc to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
   7. Spec self-review (placeholder / consistency / scope / ambiguity)
   8. User reviews written spec
   9. Transition to implementation — invoke `writing-plans` (the local penumbra version)
6. Upstream's process digraph — verbatim (update only if visual-companion is removed).
7. Upstream's "The Process" sub-sections — verbatim.
8. Upstream's "After the Design" — verbatim.
9. Upstream's "Key Principles" — verbatim.
10. **Penumbra additions section** at the bottom:
    - Slash trigger: `/brainstorm` runs the playbook for recall pre-load.
    - Recall: prior specs from `docs/superpowers/specs/*` + recent t2 memory.
    - The `writing-plans` invocation in Step 9 means the local penumbra version, not `superpowers:writing-plans`.
11. (Optional) Visual Companion section — only if `plugin/playbooks/brainstorm/visual-companion.md` is preserved or ported per audit.

Total length target: ~190–230 lines.

- [ ] **Step 3: Write the file**

Use the Write tool. Use upstream wording for restored sections to preserve the established style.

- [ ] **Step 4: Verify line count and section structure**

```bash
wc -l plugin/skills/brainstorming/SKILL.md
grep -c "^### " plugin/skills/brainstorming/SKILL.md   # should match the 8-or-9 step checklist
grep -A 2 "HARD GATE" plugin/skills/brainstorming/SKILL.md   # variance gate present
```

Expected: ~190+ lines; 8 or 9 `### Step N:` headings; "HARD GATE" appears at least twice (HARD-GATE block + Step 1.5).

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/brainstorming/SKILL.md
git commit -m "feat(plugin/skills): brainstorming — restore upstream discipline + add measurement-classification hard gate"
```

After commit: lane is ready for adversarial review by a different agent (per dispatch-quality-gates). Reviewer assignment runs at lane level, not as a separate task in this plan.

### Task 1.2: Restore `writing-plans` SKILL.md + variance-gate reference

```yaml meta
id: '1.2'
files:
  - plugin/skills/writing-plans/SKILL.md
file_scope: modify-existing
depends_on: ['1.1']
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-spark
task_size: substantial
risk_class: paste-ready
```

**Files:**
- Modify: `plugin/skills/writing-plans/SKILL.md`
- Read (audit): `docs/notes/superpowers-fork-audit-2026-05-14.md`
- Read (upstream): `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/writing-plans/SKILL.md`
- Read (spec): `docs/superpowers/specs/2026-05-14-penumbra-superpowers-fork-design.md` — short variance reference

- [ ] **Step 1: Read audit + spec variance reference**

- [ ] **Step 2: Compose the merged SKILL.md**

Structure:

1. Frontmatter — keep `name: writing-plans`, refine description.
2. `# Writing Plans` heading.
3. Upstream's `## Overview`, `## Scope Check`, `## File Structure`, `## Bite-Sized Task Granularity` — verbatim.
4. Upstream's `## Plan Document Header` block — verbatim.
5. Upstream's `## Task Structure` with TDD example — verbatim. Add a note: "In penumbra, each task body opens with a `yaml meta` block (see Penumbra additions below) BEFORE the bullet-step list."
6. Upstream's `## No Placeholders` — verbatim.
7. Upstream's `## Remember` — verbatim.
8. Upstream's `## Self-Review` — but insert a new sub-item `0. Measurement gate` at the top, with the short variance reference from the spec.
9. Upstream's `## Execution Handoff` — verbatim. Add a note: "In penumbra, plans are typically dispatched via plan-runtime (orchestrate tasks); inline execution is rare."
10. **Penumbra additions section** at the bottom:
    - Per-task `yaml meta` block (id, files, file_scope, depends_on, parallel_with, preferred_agent, fallback_agent, task_size, risk_class) — paste the block from the existing local SKILL.md.
    - Per-phase dispatch graph and integration notes — paste from existing local.
    - Validator gate — `penumbra plan validate <path>` and what it checks.
    - `preferred_agent`/`fallback_agent` must be from `chain_list_agents`.
    - Use `agent_recommend` with one of the canonical `task_type` values.
11. Slash trigger note: `/write-plan` runs the playbook for recall pre-load.

Total length target: ~180–230 lines.

- [ ] **Step 3: Write the file**

- [ ] **Step 4: Verify**

```bash
wc -l plugin/skills/writing-plans/SKILL.md
grep "yaml meta" plugin/skills/writing-plans/SKILL.md   # block schema preserved
grep "Measurement gate" plugin/skills/writing-plans/SKILL.md   # variance reference present
grep "No Placeholders" plugin/skills/writing-plans/SKILL.md   # upstream content preserved
```

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/writing-plans/SKILL.md
git commit -m "feat(plugin/skills): writing-plans — restore upstream TDD discipline + preserve dispatch-aware additions + variance gate reference"
```

### Task 1.3: Restore `test-driven-development` SKILL.md

```yaml meta
id: '1.3'
files:
  - plugin/skills/test-driven-development/SKILL.md
file_scope: modify-existing
depends_on: ['1.2']
parallel_with: []
preferred_agent: codex-acp-spark
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `plugin/skills/test-driven-development/SKILL.md`
- Read (audit): `docs/notes/superpowers-fork-audit-2026-05-14.md`
- Read (upstream): `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/test-driven-development/SKILL.md`

- [ ] **Step 1: Read audit verdict for TDD**

The audit determines whether the local TDD content is a thin shim (likely) or already substantive. If substantive, the merge is small.

- [ ] **Step 2: Compose merged SKILL.md based on audit verdict**

If audit shows local is a thin shim:
- Restore upstream TDD body (failing-test-first, observe failure, minimal impl, run, commit, refactor) verbatim.
- Add penumbra addition: `chain_start` dispatch contract — chat-only agents can't execute tests, so worker/CLI agents must run tests in worktree before claiming pass; explicit "run tests in worktree before claim" step.

If audit shows local is already substantive:
- Insert the chain_start dispatch contract note as a section if not present.
- Otherwise minimal change.

Total length target: ~120–180 lines.

- [ ] **Step 3: Write the file**

- [ ] **Step 4: Verify**

```bash
wc -l plugin/skills/test-driven-development/SKILL.md
grep -i "failing test" plugin/skills/test-driven-development/SKILL.md   # TDD core preserved
grep -i "chain_start\|worktree" plugin/skills/test-driven-development/SKILL.md   # penumbra addition present
```

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/test-driven-development/SKILL.md
git commit -m "feat(plugin/skills): test-driven-development — merge upstream TDD body with chain_start dispatch contract"
```

Integration: After Phase 1 closes, restart Claude Code session and invoke `Skill(brainstorming)`, `Skill(writing-plans)`, `Skill(test-driven-development)`. Quick visual check that the rich body loads. No automated test for skill content.


## Phase 2 — Upstream adoption

Dispatch graph: 2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4 ∥ 2.5 ∥ 2.6 ∥ 2.7

All seven tasks create new SKILL.md files at distinct paths; no shared-file collision; safe to fan out. Implementer can be the same agent across multiple tasks since the work is mechanical (copy + integration note).

### Task 2.1: Adopt `verification-before-completion`

```yaml meta
id: '2.1'
files:
  - plugin/skills/verification-before-completion/SKILL.md
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.2', '2.3', '2.4', '2.5', '2.6', '2.7']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `plugin/skills/verification-before-completion/SKILL.md`
- Read (upstream): `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/verification-before-completion/SKILL.md`

- [ ] **Step 1: Read upstream SKILL.md**

- [ ] **Step 2: Copy upstream verbatim into the new local path**

No integration note needed; this is generic discipline.

- [ ] **Step 3: Verify**

```bash
test -f plugin/skills/verification-before-completion/SKILL.md
wc -l plugin/skills/verification-before-completion/SKILL.md   # should match upstream
diff plugin/skills/verification-before-completion/SKILL.md /Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/verification-before-completion/SKILL.md   # should be empty (verbatim copy)
```

- [ ] **Step 4: Commit**

```bash
git add plugin/skills/verification-before-completion/SKILL.md
git commit -m "feat(plugin/skills): adopt verification-before-completion from upstream superpowers"
```

### Task 2.2: Adopt `systematic-debugging`

```yaml meta
id: '2.2'
files:
  - plugin/skills/systematic-debugging/SKILL.md
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.1', '2.3', '2.4', '2.5', '2.6', '2.7']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

Same pattern as Task 2.1: copy upstream verbatim, no integration note.

- [ ] **Step 1: Read upstream `systematic-debugging/SKILL.md`**
- [ ] **Step 2: Copy verbatim to `plugin/skills/systematic-debugging/SKILL.md`**
- [ ] **Step 3: Verify with diff against upstream**
- [ ] **Step 4: Commit**

```bash
git add plugin/skills/systematic-debugging/SKILL.md
git commit -m "feat(plugin/skills): adopt systematic-debugging from upstream superpowers"
```

### Task 2.3: Adopt `receiving-code-review` with adversarial-review integration note

```yaml meta
id: '2.3'
files:
  - plugin/skills/receiving-code-review/SKILL.md
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.1', '2.2', '2.4', '2.5', '2.6', '2.7']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Read upstream `receiving-code-review/SKILL.md`**
- [ ] **Step 2: Copy upstream body verbatim, then append a `## Penumbra integration` section**

```markdown
## Penumbra integration

In penumbra, the canonical code-review surface is `adversarial-review`
(multi-persona fan-out via the `adversarial-review` skill / slash). The
discipline in this skill — verify feedback claims before implementing,
challenge unclear technical assertions, refuse performative compliance —
applies to every persona's findings synthesis. When reviewing an
adversarial synthesis, treat each finding as one reviewer's claim, not
ground truth, and verify before changing code.
```

- [ ] **Step 3: Verify**

```bash
test -f plugin/skills/receiving-code-review/SKILL.md
grep "Penumbra integration" plugin/skills/receiving-code-review/SKILL.md
grep "adversarial-review" plugin/skills/receiving-code-review/SKILL.md
```

- [ ] **Step 4: Commit**

```bash
git add plugin/skills/receiving-code-review/SKILL.md
git commit -m "feat(plugin/skills): adopt receiving-code-review + adversarial-review integration note"
```

### Task 2.4: Adopt `requesting-code-review` with adversarial-review integration note

```yaml meta
id: '2.4'
files:
  - plugin/skills/requesting-code-review/SKILL.md
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.1', '2.2', '2.3', '2.5', '2.6', '2.7']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Read upstream `requesting-code-review/SKILL.md`**
- [ ] **Step 2: Copy verbatim, then append a `## Penumbra integration` section**

```markdown
## Penumbra integration

In penumbra, code-review requests are typically expressed as
`adversarial-review` fan-out (multi-persona reviewers, synthesized into
a prioritized action list). Use `adversarial-review` as the default
review surface for major features and before merge; reserve a
single-reviewer chain_start dispatch for narrow, well-scoped review
asks. Per dispatch-quality-gates, BOUNDARY-class changes require
adversarial-review; STANDARD changes may use single-reviewer or
adversarial at the maestro's discretion.
```

- [ ] **Step 3: Verify (same pattern as 2.3)**
- [ ] **Step 4: Commit**

```bash
git add plugin/skills/requesting-code-review/SKILL.md
git commit -m "feat(plugin/skills): adopt requesting-code-review + adversarial-review integration note"
```

### Task 2.5: Adopt `writing-skills` with penumbra plugin layout note

```yaml meta
id: '2.5'
files:
  - plugin/skills/writing-skills/SKILL.md
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.1', '2.2', '2.3', '2.4', '2.6', '2.7']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Read upstream `writing-skills/SKILL.md`**
- [ ] **Step 2: Copy verbatim, then append a `## Penumbra integration` section**

```markdown
## Penumbra integration

Local penumbra plugin skills live at `plugin/skills/<name>/SKILL.md`,
with optional `plugin/playbooks/<name>/playbook.md` for slash-command
recall pre-load. Frontmatter contract: `name` (matches dir name),
`description` (one specific line used by skill priority). After
writing a new skill, register the trigger (slash command) in the
playbook if recall pre-load adds value, then restart Claude Code to
reload the plugin. Validate by invoking `Skill(<name>)` and checking
the body loads with expected sections.
```

- [ ] **Step 3: Verify + commit (same pattern as 2.3)**

```bash
git add plugin/skills/writing-skills/SKILL.md
git commit -m "feat(plugin/skills): adopt writing-skills + penumbra plugin layout note"
```

### Task 2.6: Adopt `executing-plans` with plan-runtime integration note

```yaml meta
id: '2.6'
files:
  - plugin/skills/executing-plans/SKILL.md
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.1', '2.2', '2.3', '2.4', '2.5', '2.7']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Read upstream `executing-plans/SKILL.md`**
- [ ] **Step 2: Copy verbatim, then append a `## Penumbra integration` section**

```markdown
## Penumbra integration

In penumbra, plans authored via `/write-plan` are typically dispatched
via plan-runtime (per-task `kind=orchestrate` leaf to its
`preferred_agent`), not executed inline in a maestro session. This
skill applies when:
- A plan is being executed in the current session by the maestro (rare).
- Inline execution is chosen at the `writing-plans` handoff prompt.

When plan-runtime is in use, the discipline here still applies per
agent: each `chain_start` dispatch represents one task batch, and the
checkpoint review between batches is the lane_close + adversarial
review gate.
```

- [ ] **Step 3: Verify + commit**

```bash
git add plugin/skills/executing-plans/SKILL.md
git commit -m "feat(plugin/skills): adopt executing-plans + plan-runtime integration note"
```

### Task 2.7: Adopt `finishing-a-development-branch` with dispatch_land integration note

```yaml meta
id: '2.7'
files:
  - plugin/skills/finishing-a-development-branch/SKILL.md
file_scope: new
depends_on: ['1.3']
parallel_with: ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6']
preferred_agent: codex-acp-fast
fallback_agent: codex-acp-spark
task_size: small
risk_class: paste-ready
```

- [ ] **Step 1: Read upstream `finishing-a-development-branch/SKILL.md`**
- [ ] **Step 2: Copy verbatim, then append a `## Penumbra integration` section**

```markdown
## Penumbra integration

In penumbra, agent branches (`agent/<handoff_id>`) are integrated via
`dispatch_land`, which re-stamps `agent_performance.outcome` correctly
so `agent_recommend`'s success-rate column reflects post-merge reality.
Hand-merges from the home checkout (`git merge --ff-only agent/<id>`)
bypass attribution and leave stale `no_changes` / `test_failed` stamps;
they are discouraged outside of forensic recovery. Use `dispatch_land`
as the default merge path; reserve manual merges for the rare case
where reconciler verdict is poisoned by repo-wide typecheck noise
(see memory `project_reconciler_typecheck_attribution_bug`).
```

- [ ] **Step 3: Verify + commit**

```bash
git add plugin/skills/finishing-a-development-branch/SKILL.md
git commit -m "feat(plugin/skills): adopt finishing-a-development-branch + dispatch_land integration note"
```

Integration: After Phase 2 closes, restart Claude Code session and confirm `Skill(<each of the 7>)` loads body. No automated test for skill content; visual smoke is the gate.


## Phase 3 — Validation + switchover

Dispatch graph: 3.1 → 3.2 → 3.3

### Task 3.1: Behavioral smoke on ported skills

```yaml meta
id: '3.1'
files:
  - docs/notes/superpowers-fork-smoke-2026-05-14.md
file_scope: new
depends_on: ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `docs/notes/superpowers-fork-smoke-2026-05-14.md`

- [ ] **Step 1: For each of the 10 SKILL.md files touched in Phase 1 + Phase 2, verify the file exists and has the expected sections**

```bash
for s in brainstorming writing-plans test-driven-development verification-before-completion systematic-debugging receiving-code-review requesting-code-review writing-skills executing-plans finishing-a-development-branch; do
  path="plugin/skills/$s/SKILL.md"
  if [ -f "$path" ]; then
    lines=$(wc -l < "$path")
    has_frontmatter=$(head -1 "$path" | grep -c "^---" || true)
    echo "$s: $lines lines, frontmatter=$has_frontmatter"
  else
    echo "$s: MISSING"
  fi
done
```

Expected: all 10 files present, ≥ 40 lines each, frontmatter starts with `---`.

- [ ] **Step 2: For brainstorming, grep for the variance gate marker**

```bash
grep -c "HARD GATE\|Measurement classification" plugin/skills/brainstorming/SKILL.md
```

Expected: ≥ 2 (the HARD-GATE block + the Step 1.5 callout).

- [ ] **Step 3: For writing-plans, grep for the variance reference**

```bash
grep -c "Measurement gate\|variance" plugin/skills/writing-plans/SKILL.md
```

Expected: ≥ 1.

- [ ] **Step 4: Write the smoke report**

Save the results above to `docs/notes/superpowers-fork-smoke-2026-05-14.md` with a one-line pass/fail verdict at top.

- [ ] **Step 5: Commit**

```bash
git add docs/notes/superpowers-fork-smoke-2026-05-14.md
git commit -m "docs(notes): superpowers fork smoke — 10/10 SKILL.md files present + variance gate verified"
```

### Task 3.2: Grep repo for `superpowers:*` references

```yaml meta
id: '3.2'
files:
  - docs/notes/superpowers-references-audit-2026-05-14.md
file_scope: new
depends_on: ['3.1']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Files:**
- Create: `docs/notes/superpowers-references-audit-2026-05-14.md`

- [ ] **Step 1: Grep the repo for upstream-namespaced skill references**

```bash
# Find any reference to upstream superpowers namespacing
git grep -n "superpowers:" -- '*.md' '*.ts' '*.json' ':!docs/notes/*-2026-05-14*' ':!docs/notes/maestro-continuation-2026-05-*' | tee /tmp/sp-refs.txt
```

- [ ] **Step 2: Categorize each hit**

For every match, classify as:
- `update`: references should be rewritten to drop the `superpowers:` prefix once the local plugin is canonical.
- `intentional`: deliberately references the upstream historic version (e.g., in older specs/plans, audit notes); leave as-is and document.
- `historical`: reference inside docs/notes/* or commits — informational, leave as-is.

- [ ] **Step 3: Write the audit report**

`docs/notes/superpowers-references-audit-2026-05-14.md` lists each hit with its category and any action taken.

- [ ] **Step 4: Apply `update` rewrites if any are mechanical**

(If the count is high or the rewrites need judgment, this becomes a follow-up task rather than inline.)

- [ ] **Step 5: Commit**

```bash
git add docs/notes/superpowers-references-audit-2026-05-14.md
# only stage other files if updates were made
git commit -m "docs(notes): superpowers references audit — categorize repo hits, prep for upstream uninstall"
```

### Task 3.3: Uninstall upstream `superpowers@claude-plugins-official`

This task is a **maestro-manual action** — Claude Code's plugin commands are interactive. Drop the yaml meta block; plan-runtime should not dispatch this.

- [ ] **Step 1: Restart Claude Code session to reload the local plugin** (the user does this manually).

- [ ] **Step 2: Run `claude /plugin uninstall superpowers@claude-plugins-official`** in the maestro session.

- [ ] **Step 3: Verify the local penumbra `brainstorming` still resolves**

```
Skill(brainstorming)
```

If it loads, switchover is complete. If "skill not found", the local plugin isn't registering the rich SKILL.md under that name — root-cause the loader/naming.

- [ ] **Step 4: Note completion in a new memory entry** (handled in Phase 4 Task 4.2).

Integration: Phase 3.3 is the no-going-back moment. Any earlier phase can be rolled back via `git revert`; uninstall is reversed by `claude /plugin install superpowers@claude-plugins-official`.


## Phase 4 — Docs + closeout

Dispatch graph: 4.1

### Task 4.1: Update `AGENTS.md` if it references upstream superpowers

```yaml meta
id: '4.1'
files:
  - AGENTS.md
file_scope: modify-existing
depends_on: ['3.2']
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Grep AGENTS.md for `superpowers` references**

```bash
grep -n "superpowers" AGENTS.md || echo "no matches"
```

- [ ] **Step 2: For each match, rewrite to reference the local penumbra plugin canonically**

Drop `superpowers:` prefix; references like `superpowers:brainstorming` become `brainstorming` (or `penumbra:brainstorming` depending on Phase 3.3 verification).

- [ ] **Step 3: If no matches, this task is a no-op — skip commit**

- [ ] **Step 4: Commit if changes made**

```bash
git add AGENTS.md
git commit -m "docs(agents): retire upstream superpowers:* references — penumbra plugin is canonical"
```

### Task 4.2: Save memory entry for fork being canonical

This task is **maestro-manual** (writes to `~/.claude/projects/.../memory/`, not the git-tracked repo). Drop the yaml meta block.

- [ ] **Step 1: Write a memory file at `memory/project_superpowers_fork_canonical.md`** with:
  - Fork is the canonical source for `brainstorming`, `writing-plans`, `test-driven-development`, and the 7 adopted skills.
  - Upstream `superpowers@claude-plugins-official` was uninstalled on 2026-05-14.
  - The variance-gate (Step 1.5 in brainstorming) is hard-required for any measurement/eval brainstorm.
  - Future skill additions follow the `plugin/skills/<name>/SKILL.md` + optional playbook pattern.

- [ ] **Step 2: Add the memory pointer to `memory/MEMORY.md`** index.

### Task 4.3 (optional): MEMORY.md cleanup

This task is **maestro-manual**. Drop the yaml meta block. Defer to a future session if memory is low-priority.

- [ ] Audit `memory/MEMORY.md` for entries that referred to "thin-port superpowers" or "follow superpowers:brainstorming" and either retire them or update them.

Integration: After Phase 4, the fork is fully canonical. No upstream parallel install. AGENTS.md and memory reflect the new source of truth.


## Self-Review

Per `writing-plans` self-review checklist:

**1. Spec coverage:**
- Goal: restore + adopt + augment + uninstall ✓ (Phases 1, 2, 4.1 cover restore/adopt/augment; Phase 3.3 covers uninstall)
- Variance gate ✓ (Task 1.1 inserts; Task 1.2 references)
- Architecture: SKILL.md rich + playbook thin ✓ (Phase 1 structure)
- Adopted-skill list of 7 ✓ (Phase 2 has 7 tasks)
- Skipped-skill list of 4 ✓ (not built; documented in spec only)
- Migration switchover ✓ (Phase 3)
- AGENTS.md + memory closeout ✓ (Phase 4)

**2. Placeholder scan:**
- No "TBD" / "implement later" in task bodies. The optional/audit-dependent items (visual-companion sub-file, TDD audit verdict) have concrete decision rules.
- One judgment-call item: Phase 3.2 Step 4 — "if rewrites need judgment, becomes a follow-up task". That's acceptable because the rewriting count is unknown until the grep runs; capturing the option is the right move.

**3. Type / name consistency:**
- All `preferred_agent` / `fallback_agent` values are confirmed against `chain_list_agents` output. `claude-acp-sonnet`, `codex-acp-fast`, `codex-acp-deep`, `codex-acp-spark` all exist.
- Task IDs are consistent: 0.1, 1.1, 1.2, 1.3, 2.1–2.7, 3.1, 3.2, 3.3, 4.1, 4.2 (optional 4.3).
- `parallel_with` reciprocity: 2.1–2.7 each list the other six (verified in each block).


## Validator gate

Run before considering this plan ready for execution:

```bash
bun packages/cli/bin/penumbra.ts plan validate docs/superpowers/plans/2026-05-14-penumbra-superpowers-fork.md
```

Expected: passes with zero errors. Known traps (per `plan_validate_format_gotchas`):
- No `---` separators between phases (this plan uses `## Phase N` headers only).
- No inline `Dispatch graph: ` outside the per-phase block (only at phase open).
- No `file_scope: new` collisions on the same path (verified: Phase 2 tasks each create a different file; Phase 1 modifies different files).
- No `maestro` as a registered agent (Tasks 3.3, 4.2, 4.3 drop yaml meta blocks entirely).

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-14-penumbra-superpowers-fork.md`. Two execution options:

**1. Subagent-Driven (recommended for Phase 0 + Phase 1)** — Dispatch a fresh agent per task, lane_close + adversarial review between. Phase 1's three lanes especially benefit from per-lane review by a different agent than the implementer (per `feedback_reviewer_must_be_different_agent_than_implementer`).

**2. Inline execution (acceptable for Phase 2)** — The seven adoption tasks are mechanical copies + a 1-paragraph integration note; batch them in 1-2 dispatches via plan-runtime's parallel fan-out, with a single end-of-phase review pass.

Recommend Subagent-Driven for everything; Phase 2 fan-out can still go through plan-runtime since each task is independent. Which approach?
