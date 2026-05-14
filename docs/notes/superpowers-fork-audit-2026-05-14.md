# Superpowers fork audit — 2026-05-14

This audit is the input spec for Phase 1 of the superpowers fork plan
(`docs/superpowers/plans/2026-05-14-penumbra-superpowers-fork.md`). For each
of three overlapping skills (brainstorming, writing-plans,
test-driven-development), every paragraph or section of upstream and local
content is mapped to one of four verdicts:

- `keep_upstream` — present upstream, absent or weaker locally; restore in Phase 1.
- `keep_local` — penumbra-native addition; preserve.
- `merge` — both have content; combine best of each.
- `drop` — neither version should keep this in the fork.

Upstream source: `/Users/acordeiro/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/`  
Local source: `plugin/skills/<name>/SKILL.md` + `plugin/playbooks/<name>/playbook.md`

---

## brainstorming

Local SKILL.md is 33 lines — a thin shim that says "this skill opens the
`brainstorm` playbook." The playbook is 40 lines of recall config + template.
Upstream SKILL.md is 165 lines of process discipline. Almost every upstream
paragraph is absent locally; the penumbra additions live in the playbook.

### Upstream sections (5.1.0 SKILL.md)

| Section / lines | Content summary | Local equivalent | Verdict |
|---|---|---|---|
| Frontmatter (1–4) | `name: brainstorming`, description: "You MUST use this before any creative work — creating features…" | Local frontmatter has different description: pre-loaded recall + penumbra framing | `merge` — use upstream trigger wording + refine to include recall note |
| `# Brainstorming Ideas Into Designs` heading + intro (6–10) | "Help turn ideas into fully formed designs through natural collaborative dialogue. Start by understanding project context, ask one question at a time…" | Local heading is just `# Brainstorming`; intro says "this skill opens the brainstorm playbook" — no process content | `keep_upstream` |
| `<HARD-GATE>` block (12–14) | "Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it." | Absent | `keep_upstream` |
| `## Anti-Pattern: "This Is Too Simple To Need A Design"` (16–18) | "Every project goes through this process. A todo list, a single-function utility… 'Simple' projects are where unexamined assumptions cause the most wasted work." | Absent | `keep_upstream` |
| `## Checklist` — 9-item list (20–32) | Steps: 1 explore context, 2 offer visual companion, 3 clarifying questions, 4 propose 2-3 approaches, 5 present design, 6 write design doc, 7 spec self-review, 8 user reviews spec, 9 transition to writing-plans | Absent as a checklist; playbook mentions "ask one clarifying question at a time" but no numbered steps | `keep_upstream` — restore verbatim; insert variance gate as Step 1.5 per plan |
| `## Process Flow` dot digraph (34–64) | Full flow graph with decision diamonds (visual-questions?, user-approves-design?, user-reviews-spec?) and all transitions | Absent | `keep_upstream` |
| Terminal-state enforcement (66) | "The terminal state is invoking writing-plans. Do NOT invoke frontend-design, mcp-builder, or any other implementation skill." | Local `## Hand-off` says "next step is usually /write-plan" — weaker, no explicit prohibition | `merge` — restore upstream's explicit prohibition + keep local's `/write-plan` slash reference |
| `## The Process` — "Understanding the idea:" (70–79) | Scope assessment before detailed questions; decompose too-large projects; one question per message; multiple choice preferred; focus on purpose/constraints/success criteria | Absent | `keep_upstream` |
| `## The Process` — "Exploring approaches:" (81–85) | Propose 2-3 approaches with trade-offs; present options conversationally; lead with recommendation | Absent | `keep_upstream` |
| `## The Process` — "Presenting the design:" (87–93) | Scale each section to complexity; ask after each section; cover architecture, components, data flow, error handling, testing; go back and clarify | Absent | `keep_upstream` |
| `## The Process` — "Design for isolation and clarity:" (94–99) | Break system into units with one clear purpose, well-defined interfaces, independently testable; large files signal doing too much | Absent | `keep_upstream` |
| `## The Process` — "Working in existing codebases:" (101–105) | Explore structure before proposing; follow existing patterns; include targeted improvements; don't propose unrelated refactoring | Absent | `keep_upstream` |
| `## After the Design` — "Documentation:" (109–113) | Write validated design to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`; use elements-of-style if available; commit | Playbook's `fs.glob` targets `docs/superpowers/specs/*.md` implicitly, but no explicit write instruction to the agent | `keep_upstream` |
| `## After the Design` — "Spec Self-Review:" (115–124) | 4-point checklist: placeholder scan (TBD/TODO/vague), internal consistency check, scope check, ambiguity check. "Fix any issues inline." | Absent | `keep_upstream` |
| `## After the Design` — "User Review Gate:" (126–132) | Specific prompt template: "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan." Wait for response before proceeding. | Absent | `keep_upstream` |
| `## After the Design` — "Implementation:" (133–136) | "Invoke the writing-plans skill. Do NOT invoke any other skill." | Local `## Hand-off`: "the next step is usually `/write-plan`. That path is covered by the `writing-plans` skill." | `merge` — restore upstream's imperative ("Do NOT invoke any other skill") + keep local's slash notation |
| `## Key Principles` (138–146) | Six bullets: one question at a time, multiple choice preferred, YAGNI ruthlessly, explore alternatives, incremental validation, be flexible | Absent | `keep_upstream` |
| `## Visual Companion` (147–165) | Offer companion when visual content anticipated; offer must be its own message, no other content; per-question browser vs terminal decision test; read `skills/brainstorming/visual-companion.md` if accepted | Absent; no local `plugin/skills/brainstorming/visual-companion.md` or `plugin/playbooks/brainstorm/visual-companion.md` | `keep_upstream` — see Sub-files decision below |

### Penumbra-native additions (from local SKILL.md + playbook)

| Addition | Location | Verdict |
|---|---|---|
| `## When to use` — explicit when-to-trigger guidance | local SKILL.md | `keep_local` — upstream has no skip criteria; this guards against over-brainstorming |
| `## When to skip` — mechanical edit / rename / already brainstormed / "just do X" | local SKILL.md | `keep_local` |
| `## How to invoke` — use `/brainstorm` (slash handled by playbook) | local SKILL.md | `keep_local` — restructure as a short note in Penumbra additions section |
| Slash trigger `kind: slash, command: brainstorm` | playbook frontmatter | `keep_local` — stays in playbook |
| `memory.search` recall (query: brainstorm, limit: 10) | playbook recall block | `keep_local` — stays in playbook |
| `fs.glob` recall (pattern: `docs/superpowers/specs/*.md`) | playbook recall block | `keep_local` — stays in playbook |
| `agents` recall pre-load | playbook recall block (not present — brainstorm playbook does NOT pre-load agents; write-plan playbook does) | N/A |
| Markdown template: prior specs list + brainstorm-tagged memories list | playbook run block | `keep_local` — stays in playbook |
| "Follow `brainstorming`. Do not write any code or invoke any implementation skill until the user has approved a design." | playbook process section | `keep_local` — stays in playbook; duplicates the HARD-GATE for the slash-invoked context |

### Sub-files

| File | Upstream status | Local status | Notes / verdict |
|---|---|---|---|
| `visual-companion.md` | Present (288 lines): full server guide — when/how to use browser companion, start-server.sh, HTML write loop, CSS classes, browser event format, design tips, cleanup | Absent from both `plugin/skills/brainstorming/` and `plugin/playbooks/brainstorm/` | **Decision needed (flag for user):** Option A — port to `plugin/skills/brainstorming/visual-companion.md` verbatim (requires also porting the `scripts/` server files); Option B — reference upstream copy via absolute path in SKILL.md and defer porting; Option C — drop visual-companion step from Phase 1.1 checklist for now. The `scripts/` server dependency makes Option A non-trivial. |
| `spec-document-reviewer-prompt.md` | Present (50 lines): template for dispatching a spec-document-reviewer subagent | Absent | `keep_upstream` — port to `plugin/skills/brainstorming/spec-document-reviewer-prompt.md`. No scripts dependency; simple markdown. Phase 1.1 should include this copy. |
| `scripts/start-server.sh` | Present | Absent | Blocked on visual-companion decision (Option A) |
| `scripts/stop-server.sh` | Present | Absent | Same |
| `scripts/server.cjs` | Present | Absent | Same |
| `scripts/frame-template.html` | Present | Absent | Same |
| `scripts/helper.js` | Present | Absent | Same |

---

## writing-plans

Local SKILL.md is 37 lines — a thin shim with When To Use/Skip, a brief Plan Format section covering the yaml meta block schema, and a Hand-Off note. The playbook is 91 lines and contains the real dispatch-aware content: full yaml meta block template, per-phase dispatch graph syntax, integration notes, validator gate, agent_recommend task_type guidance, and reciprocity constraints. Upstream SKILL.md is 153 lines of TDD-shaped planning discipline. The two are largely complementary: upstream owns the bite-sized TDD step discipline; local owns the dispatch-aware plan structure.

### Upstream sections (5.1.0 SKILL.md)

| Section / lines | Content summary | Local equivalent | Verdict |
|---|---|---|---|
| Frontmatter (1–4) | `name: writing-plans`, description: "Use when you have a spec or requirements for a multi-step task, before touching code" | Local description: "Use when converting a spec or design direction into a phased TDD plan… Outputs a dispatch-aware plan (per-task yaml meta blocks, dispatch graph per phase) ready for plan-runtime" | `merge` — upstream trigger wording is simpler/universal; local description is penumbra-specific and more precise; combine: trigger wording + dispatch-aware output note |
| `# Writing Plans` heading (6) | Same in both | Same | `merge` (keep) |
| `## Overview` — zero-context framing (8–14) | "Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything: which files to touch, code, testing, docs. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits." | Absent — local intro is a single sentence about converting spec to plan | `keep_upstream` |
| `## Overview` — audience calibration (14–15) | "Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well." | Absent | `keep_upstream` |
| `## Overview` — announce at start (15) | **Announce at start:** "I'm using the writing-plans skill to create the implementation plan." | Absent | `keep_upstream` |
| `## Overview` — worktree context note (16–17) | "If working in an isolated worktree, it should have been created via `superpowers:using-git-worktrees` at execution time." | Absent | `merge` — port the worktree context note; update reference from `superpowers:using-git-worktrees` to penumbra's managed worktree model (MCP `worktree_*` tools) |
| `## Overview` — save path (18–20) | "Save plans to: `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`" | Absent in SKILL.md; present in playbook template as `docs/superpowers/plans/{{date}}-<feature>.md` | `keep_upstream` — restore explicit save-path instruction in SKILL.md |
| `## Scope Check` (24–26) | If spec covers multiple independent subsystems, suggest breaking into separate plans. Each plan should produce working, testable software on its own. | Absent | `keep_upstream` |
| `## File Structure` (28–35) | Before defining tasks, map out which files will be created or modified. Design units with clear boundaries. Split by responsibility, not technical layer. Follow established patterns. | Absent | `keep_upstream` |
| `## Bite-Sized Task Granularity` (37–44) | "Each step is one action (2-5 minutes)": write failing test, run to verify it fails, implement minimal code, run tests, commit — each is its own step | Absent in SKILL.md; playbook's per-task template follows this structure implicitly, but the rule is not stated | `keep_upstream` |
| `## Plan Document Header` template (46–61) | Required header block: `# [Feature Name] Implementation Plan`, agentic-workers notice, **Goal**, **Architecture**, **Tech Stack**, `---` divider | Absent in SKILL.md; absent in playbook (playbook template says "Create the plan at …" but shows no required header) | `keep_upstream` |
| `## Task Structure` — full TDD task example (63–104) | Full task block: `### Task N: [Component Name]`, **Files:** section (Create/Modify/Test), checkbox steps with code blocks, run commands, expected output | Local yaml meta block schema is the penumbra extension of this structure; absent in SKILL.md; playbook has the yaml meta template but no TDD task example | `merge` — restore upstream task structure (Files section + checkbox TDD steps + code blocks + run + expected) + add note that penumbra tasks open with a yaml meta block before the step list |
| `## No Placeholders` (106–115) | Plan failures: "TBD", "TODO", "implement later", "Add appropriate error handling" / "handle edge cases" without code, "Write tests for the above" without test code, "Similar to Task N", steps without showing how | Absent | `keep_upstream` |
| `## Remember` (116–120) | Exact file paths always. Complete code in every step. Exact commands with expected output. DRY, YAGNI, TDD, frequent commits. | Absent | `keep_upstream` |
| `## Self-Review` (122–133) | 3-point checklist after writing: 1. Spec coverage (skim each requirement, point to implementing task, list gaps); 2. Placeholder scan (red flags from No-Placeholders section); 3. Type consistency (function/method names match across tasks). "Fix inline." | Absent | `keep_upstream` — insert Measurement gate as item 0 per spec/plan |
| `## Execution Handoff` (135–153) | Offer two options: Subagent-Driven (fresh subagent per task + two-stage review) vs Inline Execution; required sub-skills for each. Exact prompt template for the offer. | Local `## Hand-Off` says "Filed plans are picked up by plan-runtime, which dispatches each task's `kind=orchestrate` leaf to its preferred agent." — different model (plan-runtime, not maestro-orchestrated inline) | `merge` — restore upstream's two-option handoff structure + add penumbra note that plan-runtime is the default dispatch path; inline execution is rare |

### Penumbra-native additions (from local SKILL.md + playbook)

| Addition | Location | Verdict |
|---|---|---|
| `## When To Use` + `## When To Skip` — explicit trigger criteria and skip rules (single-file fix, "just do it") | local SKILL.md | `keep_local` |
| Per-task `yaml meta` fenced block schema: `id`, `files`, `file_scope`, `depends_on`, `parallel_with`, `preferred_agent`, `fallback_agent`, `task_size`, `risk_class` | local SKILL.md Plan Format + playbook task template | `keep_local` — this is the core penumbra extension; must be preserved in Penumbra additions section |
| `file_scope` values: `new` / `modify-existing` / `extend-shared` with collision rules | playbook | `keep_local` |
| Per-phase dispatch graph syntax: `Dispatch graph: 1.1 → 1.2` or `2.1 ∥ 2.2 → 2.3` | playbook | `keep_local` |
| Per-phase integration notes: "Integration: <cherry-pick / FF-merge / verification command>" | playbook | `keep_local` |
| Validator gate: `penumbra plan validate <path>` — checks parallel_with reciprocity, depends_on cycles, file_scope:new collisions, agent registry membership | local SKILL.md + playbook | `keep_local` |
| `agent_recommend` wiring: query `mcp__penumbra__agent_recommend(task_type=…)` with canonical task_type values (`implement_small`, `implement_substantial`, `review_adversarial`, `docs_mechanical`, `debug_diagnose`) before fixing `preferred_agent` | playbook | `keep_local` |
| `chain_list_agents` registry check: query `mcp__penumbra__chain_list_agents` to confirm agent name exists before naming it | playbook | `keep_local` |
| `parallel_with` reciprocity constraint: "if A.parallel_with includes B, B must list A. Cycles in `depends_on` are rejected." | playbook | `keep_local` |
| Slash trigger `kind: slash, command: write-plan` | playbook frontmatter | `keep_local` — stays in playbook |
| `memory.search` recall (query: writing-plans, limit: 5) | playbook recall | `keep_local` — stays in playbook |
| `fs.glob` recall for plans (`docs/superpowers/plans/*.md`) and specs (`docs/superpowers/specs/*.md`) | playbook recall | `keep_local` — stays in playbook |
| `agents` recall pre-load (live registry snapshot) | playbook recall | `keep_local` — stays in playbook |
| Hand-off to dispatching skill for one-off `chain_start` work outside the plan | local SKILL.md Hand-Off | `keep_local` |

### Sub-files

| File | Status | Notes / verdict |
|---|---|---|
| No sub-files in upstream `writing-plans/` | Confirmed — upstream only has `SKILL.md` | N/A |
| No sub-files in local `plugin/skills/writing-plans/` | Confirmed — only `SKILL.md` | N/A |
| Local `plugin/playbooks/write-plan/playbook.md` | 91-line dispatch-aware playbook | `keep_local` — this is the primary carrier of penumbra extensions; stays thin after Phase 1 |

---

## test-driven-development

Local SKILL.md is 49 lines and is **substantive but penumbra-specific** — not a thin shim like the other two. It re-frames TDD around the dispatch contract (`chain_start` dispatch, worktree testing, agent_recommend for review), detects the test stack from project files, and has penumbra-specific common traps with memory key references. Upstream SKILL.md is 372 lines: exhaustive discipline content including the Iron Law, Red-Green-Refactor cycle, Good/Bad code examples, rationalizations, red flags, and verification checklist. The two have very little overlap in actual wording — the merge is additive in both directions.

### Upstream sections (5.1.0 SKILL.md)

| Section / lines | Content summary | Local equivalent | Verdict |
|---|---|---|---|
| Frontmatter (1–4) | `name: test-driven-development`, description: "Use when implementing any feature or bugfix, before writing implementation code" | Local description: "…Pairs with writing-plans and chain_start dispatches: the failing test becomes the dispatch contract that makes agent-driven development trustworthy." | `merge` — keep local description (more specific and penumbra-relevant); local description is strictly better |
| `# Test-Driven Development (TDD)` + `## Overview` core principle (6–16) | "Write the test first. Watch it fail. Write minimal code to pass." "Core principle: If you didn't watch the test fail, you don't know if it tests the right thing." "Violating the letter of the rules is violating the spirit of the rules." | Local: `# Test-Driven Development` + `## Why TDD pairs with penumbra dispatch` — covers the dispatch angle but not the core principle explicitly | `merge` — restore upstream's 3-line core principle above the penumbra framing; both belong |
| `## When to Use` (18–30) | Always: new features, bug fixes, refactoring, behavior changes. Exceptions (ask human): throwaway prototypes, generated code, configuration files. "Thinking 'skip TDD just this once'? Stop. That's rationalization." | Absent — local has no When to Use section | `keep_upstream` |
| `## The Iron Law` block (32–45) | "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST." "Write code before the test? Delete it. Start over." 4 rules: no "reference", no "adapt", no "look at it", delete means delete. "Implement fresh from tests. Period." | Absent | `keep_upstream` |
| `## Red-Green-Refactor` dot digraph (47–69) | Colored cycle: RED (Write failing test) → Verify fails correctly → GREEN (Minimal code) → Verify passes → REFACTOR (Clean up) → Next → RED. Includes back-edges for wrong failure and green-failure. | Absent | `keep_upstream` |
| `### RED - Write Failing Test` with Good/Bad examples (71–92, 94–106) | Write one minimal test showing what should happen. Good: `retryOperation` with `attempts` counter, clear name, tests real behavior. Bad: mock-based, vague name. Requirements: one behavior, clear name, real code (no mocks unless unavoidable). | Local `## Smallest failing test first`: "Start at the unit boundary closest to the change. One assertion is enough. Resist scope creep into integration coverage until the unit is green." | `merge` — restore upstream's Good/Bad code examples + requirements bullets; append local's "resist scope creep" nuance |
| `### Verify RED - Watch It Fail` (113–129) | "MANDATORY. Never skip." Run command. Confirm: test fails (not errors), failure message expected, fails because feature missing. "Test passes? You're testing existing behavior. Fix test." "Test errors? Fix error, re-run." | Local `## Focused loop` mentions fast red/green loop but does not make verification mandatory nor give the explicit failure-mode checks | `keep_upstream` — the mandatory framing is key discipline missing locally |
| `### GREEN - Minimal Code` with Good/Bad examples (131–166) | Write simplest code to pass the test. Good: minimal for-loop. Bad: over-engineered with options object, YAGNI. "Don't add features, refactor other code, or 'improve' beyond the test." | Absent | `keep_upstream` |
| `### Verify GREEN - Watch It Pass` (168–181) | "MANDATORY." Run tests. Confirm: test passes, other tests still pass, output pristine. "Test fails? Fix code, not test." "Other tests fail? Fix now." | Local `## Focused loop`: "Run only the affected test(s) while iterating. If the project already has unrelated failures, do not let them block a focused commit." — different guidance on unrelated failures | `merge` — restore upstream's MANDATORY framing + combine with local's focused-run guidance: run the failing test in isolation first; reserve full-project run for commit time; if pre-existing unrelated failures exist, document and stage only intentional changes |
| `### REFACTOR - Clean Up` (183–190) | After green only: remove duplication, improve names, extract helpers. Keep tests green. Don't add behavior. | Absent | `keep_upstream` |
| `### Repeat` (192–195) | Next failing test for next feature. | Absent | `keep_upstream` |
| `## Good Tests` table (197–203) | 3-row quality table: Minimal (one thing; "and" in name = split), Clear (name describes behavior), Shows intent (demonstrates desired API). | Absent | `keep_upstream` |
| `## Why Order Matters` — 5 rationalization rebuttals (205–254) | "I'll write tests after to verify it works" → passing immediately proves nothing. "Already manually tested" → ad-hoc ≠ systematic. "Deleting X hours is wasteful" → sunk cost fallacy. "TDD is dogmatic, being pragmatic means adapting" → TDD IS pragmatic. "Tests after achieve the same goals" → tests-after answer 'What does this do?'; tests-first answer 'What should this do?' | Absent | `keep_upstream` |
| `## Common Rationalizations` table (256–270) | 11-row excuse/reality table covering all the "just this once" patterns | Local `## Common traps`: 3 traps with penumbra memory key references (synthetic-pattern assertions, schema-vs-storage mismatch, staging unrelated artifacts) — different content | `merge` — keep upstream's rationalizations table + keep local's common traps as a separate `## Penumbra traps` section below |
| `## Red Flags - STOP and Start Over` (272–288) | 13 red flags: code before test, test after implementation, test passes immediately, can't explain why test failed, etc. "All of these mean: Delete code. Start over with TDD." | Absent | `keep_upstream` |
| `## Example: Bug Fix` (290–325) | Full worked example: empty-email bug → RED (write test) → Verify RED (bash output) → GREEN (implement) → Verify GREEN (bash output) → REFACTOR note | Absent | `keep_upstream` |
| `## Verification Checklist` (327–340) | 8-item checkbox: every function has a test, watched each fail, each failed for expected reason, wrote minimal code, all pass, output pristine, real code, edge cases covered. "Can't check all boxes? You skipped TDD. Start over." | Absent | `keep_upstream` |
| `## When Stuck` table (342–351) | 4-row problem/solution: don't know how to test → write wished-for API first; test too complicated → design too complicated; must mock everything → code too coupled; test setup huge → simplify design | Absent | `keep_upstream` |
| `## Debugging Integration` (353–356) | "Bug found? Write failing test reproducing it. Follow TDD cycle. Never fix bugs without a test." | Absent | `keep_upstream` |
| `## Testing Anti-Patterns` (358–361) | "When adding mocks or test utilities, read @testing-anti-patterns.md" — reference to an upstream-specific file covering mock-behavior testing, test-only methods on production classes, mocking without understanding dependencies | Absent locally; `@testing-anti-patterns.md` does not exist in penumbra | `drop` — upstream cross-reference to a file that doesn't exist locally. The anti-pattern content should be absorbed into the common-traps section rather than linked. |
| `## Final Rule` (363–371) | Code block: "Production code → test exists and failed first. Otherwise → not TDD." No exceptions without human partner's permission. | Absent | `keep_upstream` |

### Penumbra-native additions (from local SKILL.md)

| Addition | Location | Verdict |
|---|---|---|
| `## Why TDD pairs with penumbra dispatch` — "The failing test is the spec. Without it, a dispatched agent only has prose to interpret, and prose drifts. With it, the agent gets a binary red/green signal, and the reviewer gets an unambiguous merge gate." | local SKILL.md | `keep_local` — this is the core penumbra framing; has no upstream equivalent |
| `## Detect the test stack` — check `package.json scripts.test`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, existing `*test*` files; mirror their layout/framework/assertion style; do not introduce a new test runner | local SKILL.md | `keep_local` — penumbra-specific; no upstream equivalent |
| `## Real behavior, not pattern-matching` — "Assertions must check actual outcomes: content, return values, and side effects. If the test would pass against a stub that just echoes the expected value, the test is too weak." | local SKILL.md | `keep_local` — keep as a named principle even though upstream's Good/Bad examples illustrate it; the prose form is useful for dispatched agents |
| `## Focused loop` — "Run only the affected test(s) while iterating. Reserve full-project typecheck or lint for commit time. If the project already has unrelated failures, do not let them block a focused commit. Stage only the files you intentionally changed." | local SKILL.md | `keep_local` — penumbra-specific workflow; addresses the pre-existing-failure noise that is endemic to the penumbra repo |
| `## For dispatched implementations` — 4-step protocol: write failing test locally or in dispatch prompt verbatim; include test path + body + command + "do NOT modify the test" in `chain_start` message; dispatch reviewer via `agent_recommend(task_type="review_adversarial")`; run focused test against agent's worktree via `worktree_inspect` before cherry-picking | local SKILL.md | `keep_local` — this is the primary penumbra extension; no upstream equivalent |
| `## Common traps` — 3 traps with memory key cross-references: synthetic-pattern assertions (memory: `Trap: Initial Worktree Test Idea Inadequate`), schema-layer change without storage-layer update (memory: `Trap: Schema Layer vs. Actual Table Mismatch`), staging unrelated typecheck artifacts (memory: `User Preference: Stage Only Intended Source and Test Edits`) | local SKILL.md | `keep_local` — penumbra-specific institutional memory; no upstream equivalent |

### Sub-files

| File | Status | Notes / verdict |
|---|---|---|
| No sub-files in upstream `test-driven-development/` | Confirmed — upstream only has `SKILL.md` | N/A |
| No sub-files in local `plugin/skills/test-driven-development/` | Confirmed — only `SKILL.md` | N/A |
| No local playbook for TDD | `plugin/playbooks/test-driven-development/` does not exist | N/A — TDD has no slash trigger; skill is invoked directly |

---

## Summary

**brainstorming:** 18 upstream sections mapped: 15 `keep_upstream`, 3 `merge`, 0 `drop`. 9 penumbra-native additions all `keep_local`. The local SKILL.md is almost entirely absent of upstream content; nearly the entire 165-line upstream body needs restoring. The playbook is clean and should remain unchanged. **Key decision needed from user before Phase 1.1:** how to handle the visual-companion sub-file (288 lines + 5 server scripts). Options: A) port the full `scripts/` directory and `visual-companion.md` to the penumbra plugin (non-trivial — requires porting a Node.js server); B) reference the upstream path by absolute path until a future port; C) drop the Visual Companion step from the checklist (simplest, lowest risk). The `spec-document-reviewer-prompt.md` is a simple port with no dependencies and should be included in Phase 1.1 regardless of the visual-companion decision.

**writing-plans:** 14 upstream sections mapped: 10 `keep_upstream`, 3 `merge`, 0 `drop`, 1 subsection to update (worktree note references `superpowers:using-git-worktrees` → rephrase for penumbra MCP model). 10 penumbra-native additions all `keep_local`. The local additions are heavily in the playbook and are comprehensive; upstream owns the process-discipline content (zero-context framing, No Placeholders, Self-Review, bite-sized steps). This is a clean additive merge with no conflicts.

**test-driven-development:** 22 upstream sections mapped: 17 `keep_upstream`, 4 `merge`, 1 `drop` (`Testing Anti-Patterns` reference to nonexistent `@testing-anti-patterns.md`). 6 penumbra-native additions all `keep_local`. Unlike the other two skills, the local TDD SKILL.md is substantive (not a shim) — it has a distinct penumbra dispatch framing that should be preserved as a section alongside the restored upstream body. The merge is additive: upstream owns the discipline (Law, cycle, examples, rationalizations, checklist); local owns the dispatch contract protocol (chain_start, worktree_inspect, agent_recommend, focused loop, stack detection).

**Open questions requiring user input before Phase 1 starts:**

1. **Visual companion handling** — Option A (port), B (reference upstream path), or C (drop from checklist). This affects Task 1.1 scope significantly (port = +5 binary/script files; drop = remove 1 checklist item and the digraph branch).
2. **`spec-document-reviewer-prompt.md`** — port as `plugin/skills/brainstorming/spec-document-reviewer-prompt.md` (simple, no deps) or incorporate its template text inline into SKILL.md? Recommend porting as a standalone file to keep SKILL.md within the 190–230 line target.
3. **TDD `@testing-anti-patterns.md` drop** — confirm the drop verdict: replace the single-sentence reference with inline bullets absorbing the three listed anti-patterns (mock behavior, test-only methods, mocking without understanding). Alternatively, create a `plugin/skills/test-driven-development/testing-anti-patterns.md` now. Given the plan's YAGNI stance, inline absorption is preferred.
