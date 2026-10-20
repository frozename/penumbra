---
name: writing-plans
description: Use when converting a spec into a phased TDD plan. Outputs dispatch-aware tasks (per-task yaml meta blocks, per-phase dispatch graphs) ready for plan-runtime to execute via chain_start.
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If working in an isolated worktree, it was created by the penumbra worker via `worktree_*` MCP tools, not by hand.

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`

- (User preferences for plan location override this default)

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Bite-Sized Task Granularity

**Trust boundary:** Spec text and design-doc content are user/maestro input; they MUST NOT be interpolated directly into bash commands (commit messages, file paths, shell args) without sanitization.

- Use heredoc with quoted delimiter (`<<'EOF'`) for commit message bodies; never `git commit -m "$SPEC_TEXT"` with unquoted expansion.
- Never use spec text as a path component, branch name, or other shell argument without an allowlist check (alphanumeric + `-_`).
- If a task step writes spec content to a file, write through a redirect (`> path`) — not through interpolation into another command's args.

**Each step is one action (2-5 minutes):**

- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

In penumbra, include `yaml meta` only when required (see Penumbra additions below).

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
---
plan_id: [unique plan id, e.g. the file's basename]
home_project: [projects.yaml id the plan belongs to]
---

# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

Penumbra tasks add a yaml meta block before the Files section. Full schema in the Penumbra additions section below.

````markdown
### Task N: [Component Name]

**Files:**

- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**

```text
def test_specific_behavior():
    <test code here>
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: targeted failure

- [ ] **Step 3: Write minimal implementation**

```text
def function(input):
    <implementation here>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit <<'EOF'
feat: add specific feature

Detailed commit message body
EOF
```
````

## No Placeholders

**Sensitive data in plan artifacts:** Plans are committed to git and read by every agent that dispatches against them. Do NOT embed sensitive values (API keys, customer PII, internal hostnames, secrets) in plan tasks. If a task needs to reference a sensitive value, use a placeholder (`<API_KEY>`, `<CUSTOMER_ID>`) and resolve it at dispatch time via environment or vault.

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember

- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**0. Measurement gate (if applicable):** If this plan involves measuring,
comparing, or evaluating something via a metric, the input spec MUST
include a variance / distribution query result for the primary metric.
If absent, return to brainstorming (this gate exists because evals
without variance are unmeasurable; see `brainstorming` Step 1.5).

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After plan validation and self-review pass, present the two execution options and capture user choice:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, with review between tasks for fast iteration.
2. **Inline Execution** - execute tasks in this session using `executing-plans`, with batch execution and checkpoints.

**Penumbra default:** In penumbra, filed plans under `docs/plans/` are picked up by plan-runtime, which dispatches each task's `kind=orchestrate` leaf to its `preferred_agent` (fan-out, default).

**If Subagent-Driven chosen:**

- **REQUIRED SUB-SKILL:** Use `subagent-driven-development`
- Fresh subagent per task + two-stage review

**If Inline Execution chosen:**

- **REQUIRED SUB-SKILL:** Use `executing-plans`
- Batch execution with checkpoints

For one-off `chain_start` work outside a filed plan, use the `dispatching` skill.

## Penumbra additions

### When to include `yaml meta`

When the yaml meta block is required: Every task that should be dispatched by plan-runtime (`kind=orchestrate`) MUST open with the yaml meta block. Tasks that are explicitly maestro-manual (user clicks, plugin uninstall, restart-Claude-Code, memory file writes to `~/.claude/...`) MUST OMIT the yaml meta block — plan-runtime sees only meta-bearing tasks. Use prose-only task entries for manual steps; the validator will not flag them.

### Per-task yaml meta block

Each task body must open with a fenced `yaml meta` block before the Files section:

```yaml meta
id: "<phase>.<task>"
files:
  - <path>
file_scope: new | modify-existing | extend-shared
depends_on: [<other task ids>]
parallel_with: [<other task ids>]
preferred_agent: <agent name from registry>
fallback_agent: <agent name from registry>
task_size: small | substantial | risky
risk_class: paste-ready | schema-aware | bootstrap-touching
```

**Reciprocity:** if A.`parallel_with` includes B, B must list A. **Cycles** in `depends_on` are rejected by the validator.

### Per-phase dispatch graphs

Each phase opens with a dispatch graph showing task ordering and parallelism:

```
Dispatch graph: 1.1 → 1.2 → 1.3
```

or, for fan-out:

```
Dispatch graph: 2.1 ∥ 2.2 → 2.3
```

Each phase closes with an integration note:

```
Integration: <one or two sentences on cherry-pick / FF-merge / verification command>
```

### Validator gate

After writing the plan, run:

```bash
bun packages/cli/bin/penumbra.ts plan validate <path>
```

The validator checks:

- the front matter on line 1 declares `plan_id` and `home_project` (`header_missing` otherwise)
- `parallel_with` reciprocity (A lists B → B must list A)
- `depends_on` cycles (rejected)
- `file_scope: new` collisions (same path declared new in two tasks)
- `preferred_agent` / `fallback_agent` registry membership

Known traps (per `plan_validate_format_gotchas` memory): no `---` separators between phases (use `## Phase N` headers only); no inline `Dispatch graph:` lines outside the per-phase block; `maestro` is not a registered agent — drop yaml meta blocks from maestro-manual tasks entirely.

Register the plan: `penumbra registrar register <plan-file>`.

### preferred_agent / fallback_agent discipline

Before naming an agent, query `mcp__penumbra__agent_recommend` with the matching `task_type`:

| task_type               | When to use                             |
| ----------------------- | --------------------------------------- |
| `implement_small`       | Single-file or focused small change     |
| `implement_substantial` | Multi-file, phase-spanning work         |
| `review_adversarial`    | Code review, multi-persona fan-out      |
| `docs_mechanical`       | Doc writing, audit notes, smoke reports |
| `debug_diagnose`        | Root-cause investigation                |
| `plan_refine`           | Plan editing and scope refinement       |
| `smoke_test`            | Verification and smoke dispatches       |
| `health_check`          | Status checks, infra probes             |
| `unknown`               | Fallback when no type fits              |

Confirm the returned name exists via `mcp__penumbra__chain_list_agents` before writing it into the plan. Unknown agent names cause validator failures and silent dispatch drops.

### Slash trigger

`/write-plan` invokes the playbook at `plugin/playbooks/write-plan/playbook.md`, which pre-loads recent specs (`docs/specs/*.md`), existing plans (`docs/plans/*.md`), recent writing-plans memory, and the live agent registry before the process begins.
