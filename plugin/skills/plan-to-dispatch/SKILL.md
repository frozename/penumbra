---
name: plan-to-dispatch
description: Use when a source artifact — a PR review, an external spec, an audit report, a design doc — carries many claims that must become many fleet dispatches, and those claims have not been checked against the live tree. Also use when a plan document must survive `plan validate`, reach the registrar with every phase intact, and then be dispatched. Not for a single trivial edit.
---

# Plan To Dispatch

## Overview

A source artifact is a set of hypotheses. This skill turns one into a validated, registered, dispatch-ready phased plan without inheriting the source's errors, and without hand-typing a single repo constraint into a prompt.

Fourteen steps in four stages: **GROUND** (1-4), **VERIFY** (5-8), **AUTHOR** (9-11), **REGISTER+DISPATCH** (12-14). Stages 1-4 and 12-14 are cheap and mostly mechanical. Stage 5-8 is where the money is: it is the difference between planning against the source and planning against the tree.

**Announce at start:** "I'm using the plan-to-dispatch skill to turn <artifact> into a validated plan."

## When to Use

Use when:

- A review, spec, audit or design doc arrives carrying more claims than you can personally re-verify in one pass, and each claim would become a separate change.
- The output has to be a plan document that `bun packages/cli/bin/penumbra.ts plan validate` accepts and the registrar records phase-by-phase.
- The work will be executed by the fleet rather than by hand, so every task needs a concrete seat, a file scope, and a dependency edge.

Do **not** use when:

- The change is one trivial edit, or a diagnosis you can close in the same turn. The pipeline costs more than the work.
- The source is a single claim you can verify in one command. Verify it and fix it.
- You already hold a verified backlog. Skip to AUTHOR — but keep step 11 (audit) and step 12 (validate).

## The trust rule

**Never plan directly from a review. Verify first, then scope PARTIAL findings down to the part that is real.**

Measured on the PR-167 run, 54 claims from two source documents:

| Verdict                                        | Count  |
| ---------------------------------------------- | ------ |
| CONFIRMED                                      | **23** |
| PARTIAL                                        | **21** |
| REFUTED                                        | **10** |
| Defects the source missed (1 critical, 4 high) | **5**  |

Read that as: **fewer than half** the claims survived intact, nearly **40%** were partly wrong in a way that changes the fix, and the single most consequential defect in the whole document was one the source never mentioned.

Worse, one claim's **premise was exactly inverted**. The source asserted that every workflow-issued dispatch carries `workflow_run_id` through to `handoffs` and that "nothing reads it back", and built a cost/telemetry join on that. A live query settled it:

```
SELECT COUNT(*) n, SUM(workflow_run_id IS NOT NULL) set_n
  FROM handoffs WHERE dispatch_kind='workflow';
-> {"n":2786,"set_n":0}
```

The field is never written. Everything the source proposed on top of that join was planning against a column that is always NULL. Had the pipeline trusted the document, it would have produced a phase of work whose tests pass vacuously against zero rows.

Rules that follow:

- A CONFIRMED verdict still needs the **corrected** file:line — source line refs are stale by default.
- A PARTIAL is not a small CONFIRMED. Scope the task down to the confirmed half and record the refuted half as declined, with the reason, so it is not re-litigated.
- A REFUTED claim is not free: ask why the source believed it. Twice that question surfaced a real defect adjacent to the false one.
- Every finding must carry `already_tested`. A defect a test already pins is not a task.

## Stage 1 — GROUND (steps 1-4)

**Produces:** the full source text, a known base commit, a reproduction verdict on the source's own numbers, and a recorded gate baseline with real exit codes.

**Prevents:** planning against a moving base, and the "no regressions" claim with nothing to diff against.

1. **INGEST.** `gh pr view <n> --json title,body,files,headRefName` and `git show <branch>:<path>` for each document. Read them in **full**. Never summarize a source you are about to plan against — the summarizing pass is where an inverted premise becomes invisible.
2. **GROUND.** `git merge-base`, behind-by count (`git rev-list --count <head>..origin/main`), a conflict probe (`git merge-tree`), `node_modules` presence, `bun --version`, remote state. Record the base SHA in the plan header.
3. **REPRODUCE.** Re-run the numbers the source claims for itself. If the source says a suite is 531/0 and it is not, every downstream claim is suspect and the whole artifact drops to untrusted. On the PR-167 run both claimed suites reproduced, which is why the pipeline continued.
4. **BASELINE.** Capture the real gate, before any change:

```
bun run typecheck                        # exit 0
bun scripts/check-typecheck-coverage.ts  # the ratchet; runs BEFORE the shards in CI
bun run lint:strict                       # blocking, --max-warnings=0
bun scripts/bun-test-gate.ts packages/<pkg> \
  --path-ignore-patterns='**/console/e2e/**' \
  --path-ignore-patterns='**/visual/**' \
  --path-ignore-patterns='**/dist/**' \
  --path-ignore-patterns='**/scripts/bench*.test.ts'
bun scripts/bun-test-gate.ts --path-ignore-patterns='packages/**' <same ignores>   # root shard: test/ + scripts/
```

**Exit-code discipline, non-optional.** Redirect to a file and read the status on its own line:

```
bun scripts/bun-test-gate.ts packages/daemon <ignores> >/tmp/gate.out 2>&1
echo "EXIT=$?"
```

Never `cmd | tail -20; echo $?` — that reports `tail`'s status. On the PR-167 run this mis-reported two gates as green. Under zsh a pipeline's first status is `$pipestatus[1]`, not `$?`.

Two more baseline facts worth carrying into the plan: the real test gate is **sharded per package** through `scripts/bun-test-gate.ts` — root `bun test` is not the gate and crashes Bun — and `bun run format:check` may be red at base and is **not** in CI, so a plan must say "do not reformat" rather than let a worker chase it.

## Stage 2 — VERIFY (steps 5-8)

**Produces:** one record per claim, one substrate map per dimension, a critic pass, and a personally re-verified core.

**Prevents:** shipping the source's errors; and, via `conflicts_with`, an unsequenceable pile of findings.

5. **VERIFY fan-out.** One agent per claim **cluster**, not per claim. Invoke through the codified fan-out rather than hand-gluing a dispatch loop:

   ```
   mcp__penumbra__workflow_run({ name: "penumbra-fanout", args: { repo: "<absolute repo path>", tasks: [ ... ] } })
   ```

   Contract each agent must return, per claim:

   ```
   { claim_id, title,
     verdict: CONFIRMED | PARTIAL | REFUTED | STALE_REFS,
     evidence,            // corrected file:line + the quoted code, re-located from scratch
     already_tested,      // does a test ALREADY pin this?
     failure_scenario, severity, fix_sketch, test_sketch,
     check_command, files_to_touch, package_scope, est_size,
     conflicts_with }     // do not omit — this is what makes the output sequenceable
   ```

   Tell each agent that source line refs are assumed stale and must be re-located before use.

6. **RECON fan-out.** One agent per **substrate dimension**, returning `{ summary, facts[{fact, evidence}], gaps[{missing, where_it_would_live, existing_pattern_to_copy, est_size}], traps[] }`. The seven dimensions that earned their cost: target-interface surface, component anatomy, data/schema, gates+CI, integration surface, project conventions (validator / seat registry / registrar), feasibility+concurrency. **`traps` with a blast site is the highest-value field in the whole pipeline** — it is what an implementing agent trips on, and a trap without a blast site and an activation condition is just a note.
7. **CRITIC.** One agent, three questions: what did the source **miss** in the areas it covered (same failure class), what is still unknown, and which findings **must not** be parallelized. On PR-167 this returned 5 high/critical defects the source never mentioned and 12 sequencing hazards.
8. **TRIAGE.** Orchestrator work. See below — this one does not delegate.

## Stage 3 — AUTHOR (steps 9-11)

**Produces:** the assembled plan document.

**Prevents:** cross-phase naming drift, duplicate ids, fabricated evidence, and phases ordered so their own tests cannot go RED.

9. **SEQUENCE.** Derive phase order from `conflicts_with` plus the critic's hazards. Orchestrator judgement; see the constraint shapes below.
10. **AUTHOR.** One agent per phase. **The orchestrator owns the skeleton** — the phase list, the phase titles, the task id ranges — so numbering and naming stay consistent; agents own the detail inside their phase. Each agent receives:
    - a strict **output format contract** (heading levels, the `yaml meta` block shape, the step syntax);
    - its **evidence slice**, selected by claim id — never the whole findings set;
    - the **real gate commands** and the **verified baseline numbers**;
    - the **registered seat names** it may pin.
      All four come from `bun scripts/plan-context.ts`. None is typed by hand. Require agents to read real source before writing any code step.
11. **AUDIT.** One agent over the **assembled** document, not the fragments: validator rules, duplicate or malformed ids, leftover placeholders, cross-phase naming inconsistency, ordering violations, fabricated evidence. Fragment-level review cannot see any of those.

## Stage 4 — REGISTER + DISPATCH (steps 12-14)

**Produces:** a plan that the validator accepts, a registrar entry with every phase present, and dispatched work.

**Prevents:** a plan that validates but cannot run; a phase that silently never reaches the registrar.

12. **VALIDATE.** `bun packages/cli/bin/penumbra.ts plan validate <path>` — exit 0 clean, exit 2 on any parse or rule failure, errors on stderr as `<task_id>: <rule>: <message>`. Do not skip the mutation check in the next section.
13. **REGISTER.** Two paths, and they differ:
    - `bun packages/cli/bin/penumbra.ts registrar register <plan-file>` — derives title from the first heading, slug from the filename, phases from the `## Phase N` headers. Idempotent: HTTP 409 prints `already registered: <slug>` and exits 0. It **omits** `status`, so the entry is created **active** — the CLI cannot create a draft.
    - `mcp__penumbra__registrar_create({ title, slug, home_project, phases, source_doc_path, status: "draft" })` — the only path to a draft, and it **throws** on a taken slug instead of returning 0.
      Then verify the phases actually landed:

    ```
    grep -cE '^## Phase [0-9]+( — |: )' <plan>      # em dash or colon only
    mcp__penumbra__registrar_status({ registrar_id })  # count what came back
    ```

14. **DISPATCH.** Role-route every dispatch (`initial_agent: "executor"`, `"reviewer"` for review work) and run the fan-out through a codified workflow. Then land, verify HEAD moved and the content is in main, and only then tear down and `lane_close`. **One irreversible step per turn.** Never bundle a land with a branch or worktree delete — if the land fails, the teardown deletes unlanded work.

## The steps that must stay human

Four things in this pipeline do not delegate. Automating them away is how the source's errors get laundered into a plan.

- **Deciding the source is trustworthy** (step 3). If its own claimed numbers do not reproduce, stop and say so; do not proceed with a discount.
- **Personally re-verifying the load-bearing findings against live state** (step 8). Agents over-report and contradict each other. On PR-167 one verify agent returned **REFUTED at critical severity** on the `workflow_run_id` claim while the critic returned **CRITICAL** on the same field, and a recon map independently said the opposite of the verify agent. Nothing in the agent output could settle it — the verdicts were symmetric and both well-argued. **A live DB query settled it**: 2786 workflow-kind handoff rows, 0 with the column populated. The critic was right. A pipeline that had merged those verdicts by vote, confidence, or seniority would have shipped the review's inverted premise into a phase of dead work.
  The rule: for any finding that a whole phase depends on, open the cited code and query the live state yourself. Re-verify the load-bearing few, not all 54.
- **Sequencing judgement** (step 9). The shapes below are recognizable; which one dominates a given pair of findings is not.
- **Every irreversible action.** Push, `dispatch_land`, worktree teardown, registrar transitions. Name the rollback, then act.

## Sequencing constraint shapes

Look for these four when ordering phases. Each has cost the repo a shipped-but-inert change at least once.

**(a) Same-file serialization.** Two tasks editing one file cannot be parallel, however independent the logic. Example: five separate findings — a route defect, a status-truthfulness fix, a missing deadline, a telemetry field and a max-lines split — all edit `packages/daemon/src/routes/workflows.ts` (1538 lines). One worker at a time, and the file split lands **last**, or every earlier branch conflicts against it. The same applies to two workers rewriting one 187-line script for what turns out to be the same defect filed under two ids.

**(b) Writer-before-reader.** A reader fix has **no true RED** until the writer emits the field. Example: the telemetry phase's readers cannot be given a failing assertion until the earlier phase writes `handoffs.workflow_run_id` and the capture path emits the outcome fields. Write the reader test first and it passes vacuously against zero rows — a green test that pins nothing. Order writer, then reader, and say so in the plan.

**(c) ARM-WITH-UNBLOCK.** Turning on a gate, cap or fence **without its release path** converts dead code into starvation. Example: writing `workflow_run_id` arms a claim-spread fairness cap that had been inert. A capped claim returns 409, and its only rediscovery route is the worker poll loop — which is suppressed while SSE is live. Arming the cap without also landing the re-offer path would convert an inert feature into a stalled queue. This repo has already shipped that exact failure once, on a promotion queue: unblocking the head of line by deferring converted a livelock into throughput starvation. The arm and its unblock land **as one unit**, in one phase.

**(d) Observability-before-expansion.** Make the failure legible before you add more things that can fail that way. Example: a workflow directory that fails to build vanishes silently — the registry catches per-file and moves on. Land the boot-time error logging **before** adding any new loadable unit, otherwise a unit that failed to build is indistinguishable from one that was never deployed, and every subsequent step debugs blind.

A fifth, repo-specific: **global-state safety before global-state edits.** Fix the write-through hazard on a shared mirror before editing anything that syncs into it.

## Verification of your own gates

A gate you have not mutated is a gate you have not verified. Exit 0 from `plan validate` can mean "the plan is clean" or "the parser found zero tasks".

**Mutate the validator, on a copy, twice:**

1. Inject a role where a seat belongs. Set `preferred_agent: executor` in one task and re-run validate. Expect exit 2 and, verbatim:
   `1.1: preferred_agent_unknown: preferred_agent "executor" is not in the registry`
   If it exits 0, your mutation did not land or your file has no parsed tasks.
2. Break one side of a `parallel_with` pair — remove the back-reference from the partner task. Expect `parallel_with_not_reciprocal`. A one-sided pair is the most common authoring defect and the cheapest to miss.

**Prove the mutation actually landed before trusting the verdict.** BSD `sed` — the `sed` on this platform — does **not** support the GNU `0,/re/` address form. It exits **0** and changes **nothing**:

```
$ printf 'a\nb\na\n' > f; sed '0,/a/s//X/' f
a
b
a
$ echo $?
0
```

A mutation harness built on `0,/re/s//…/` silently no-ops and reports a passing check on an unmutated file. Use a plain targeted substitution on a copy and `diff` the copy against the original to confirm the byte changed, then run the gate.

**Count what was parsed.** Compare the number of task blocks you wrote against the number the parser found, because an unclosed block is dropped with no error:

````
grep -c '^```yaml meta' <plan>     # blocks written
````

If the parsed task count is lower, a block is unclosed or a heading was eaten. There will be no error message telling you so.

## Known format traps

Each with the blast site — where the damage lands, not where the mistake is typed.

| Trap                                                              | Blast site                                                                      | What happens                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ASCII hyphen in a phase header** (`## Phase 3 - Foo`)           | `packages/cli/src/commands/registrar.ts:20`, regex `/^## Phase \d+(?: — \|: )/` | The header does not match. The phase is **silently dropped** from the POST body; the daemon returns 201 and the phase simply is not in the registrar. Only if _every_ header uses a hyphen does the empty-array check surface a 400. An en dash fails too — it must be U+2014 with one space each side, or `: `.                             |
| **An agent wrapping a whole phase in a markdown fence**           | the plan parser                                                                 | The returned fence markers collide with the phase's own yaml meta blocks. Blocks end up unclosed or nested, and an unclosed block is ignored "by the format contract" with **no error pushed**. The plan validates clean with fewer tasks than you wrote. Strip outer fences from every agent's output before assembling, then count blocks. |
| **Unquoted `id: 11.10`**                                          | the task id map                                                                 | YAML parses it as the **number 11.1**, which stringifies to `"11.1"` and **collides with task 11.1**. `depends_on` and `parallel_with` then resolve to whichever task was written last, and no rule fires. Quote every id, and every `depends_on` entry — they are matched as strings against `/^[\d.]+$/`.                                  |
| **Absolute pass counts across phases**                            | every later phase's step 4                                                      | Phase 1 adds tests, so phase 6's "expect 2266 pass" is wrong the moment phase 1 lands, and the worker reports a false failure. State every expectation as **"baseline + N"** against the worker's own pre-change run of that shard.                                                                                                          |
| **A `## ` line between a `### ` task heading and its yaml block** | the parser's pending-heading state                                              | A `## ` line clears the pending heading. The task keeps its meta and loses its heading. Task headings are `### `; do not open a `## ` subsection inside a task.                                                                                                                                                                              |
| **`file_scope: new` on a path that exists**                       | re-validation after phase 1                                                     | The existence check runs against the **disk** at validation time. Validate, dispatch phase 1, re-validate — the files phase 1 just created now fail `file_already_exists` and a clean plan becomes exit 2. Re-validate against the base tree, or expect and read past this rule.                                                             |
| **Plan lives in a gitignored directory**                          | any dispatched worker                                                           | `docs/plans/` and `docs/notes/` are gitignored. The plan is a **local artifact**; a worker in an isolated worktree cannot read it. The registrar entry — not git — is what makes it discoverable, and task content must be passed **in the dispatch message**.                                                                               |
| **Filename-derived slug**                                         | `registrar register`                                                            | The slug comes from the filename with leading/trailing `YYYY-MM-DD` stripped, and must match `/^[a-z][a-z0-9-]*$/`. A name starting with a digit, or one that strips to empty, returns HTTP 400.                                                                                                                                             |

## Do not hand-type constraints

**Every constraint the authoring agents need is generated, never typed:**

```
bun scripts/plan-context.ts
```

Inject its output into every authoring prompt. Type none of it into a prompt yourself.

Why this is the highest-value rule in the skill: on the PR-167 run, **every one of these was a discovery made the hard way, and every one of them drifts.**

- **The seat list is live.** The plan validator checks `preferred_agent` / `fallback_agent` against the daemon's registered seats from `GET /chains/agents` — 62 at capture — plus the `maestro-inline` sentinel. It **rejects a role**: `preferred_agent: executor` fails `preferred_agent_unknown`. Roles exist at `chain_start` time, not at plan-validation time.
- **The runtime wants more than the validator does.** Plan-runtime additionally requires the seat be `maestro_capable`, and that flag is **not** on the HTTP surface — `GET /chains/agents` returns `{name}` and nothing else. It lives only in `~/.config/penumbra/agents.yaml`, where `agents` is an **array**, not a map. 11 of 62 qualify. A seat in the registry but not maestro-capable **validates clean and fails at run time**.
- **Routing biases are time-varying.** At capture, 3 of those 11 sat under a standing provider exclude. The usable set is the intersection of registry and `maestro_capable`, **minus** the seats covered by an active routing bias — and biases carry `expires_at`, so presence in the list is not the same as being active. Any hard-coded seat list is wrong within days.
- **The validator fails open when the daemon is down.** With no daemon, the CLI warns to stderr and falls back to a **5-name** built-in list. A plan pinned to a real seat then fails `preferred_agent_unknown` for reasons that have nothing to do with the plan, and a plan pinned to a fallback name validates only while the daemon is down. The generator therefore reads `/chains/agents` **itself and aborts on failure**, rather than trusting the validator's verdict.
- **Gate commands are derived, not remembered.** From `package.json` scripts and the CI workflow — which is also the authority on gate **order**: typecheck, then the coverage ratchet, then the shards, then `lint:strict`. A failure in an early step **skips every later one**, so a blocking failure can hide for several commits.
- **Validator rule names, id regexes and enum values come from source** (`plan-meta/validator.ts`, `plan-meta/schema.ts`), and the phase-header regex is extracted from `registrar.ts` rather than restated — restating it is exactly how the hyphen trap gets reintroduced.

If the generator cannot reach the daemon or the config, **stop**. Do not author against a guess.

## Common Mistakes

- **Summarizing the source before verifying it.** The summary drops the premise, and the premise is what was inverted.
- **One agent per claim.** Fifty-four dispatches for fifty-four claims is cost without signal; claims cluster by file and by mechanism. Cluster, then fan out.
- **Omitting `conflicts_with`.** The findings come back complete and unsequenceable, and step 9 becomes a guess.
- **Auditing the fragments instead of the assembled document.** Duplicate ids, naming drift and ordering violations exist only at the seam.
- **Treating exit 0 as proof.** It is proof only after a mutation has been shown to bite.
- **Landing and tearing down in the same turn.** If the land fails, the teardown deletes the work.
- **Registering before the audit.** The CLI path creates an **active** entry; if you intend to review the plan first, use the MCP path with `status: "draft"`.

## Real-World Impact

The PR-167 run: two source documents, 54 claims, 22 verification agents, 7 substrate maps, 1 critic, 11 phases authored in parallel. Output: a plan that passes `plan validate` at exit 0 with a clean stderr, registered with all 11 phases intact. Of the source's own recommendations, 10 were refuted outright and 21 were scoped down; 5 defects it never mentioned were added, including the critical one that made its central premise backwards. The single most expensive step was the one that cannot be automated: querying the live database to break a tie between two agents that disagreed.

## Penumbra integration

- Fan-outs (VERIFY, RECON, AUTHOR): `mcp__penumbra__workflow_run` with `penumbra-fanout`; poll with `mcp__penumbra__workflow_wait` / `workflow_status`. Pass `repo` as an **absolute** path — the fan-out fails closed on a relative one.
- Dispatch: `mcp__penumbra__chain_start` with `initial_agent` as a **role**; a concrete seat name is a deliberate pin and carries a one-line reason.
- Verification of a returned branch: `mcp__penumbra__worktree_inspect`, `mcp__penumbra__dispatch_audit` (its payload nests under `report`).
- Registration and progress: `mcp__penumbra__registrar_create` (the only path to `status: "draft"`), `registrar_append`, `registrar_status`, `registrar_list`.
- Landing: `mcp__penumbra__dispatch_land`, then `mcp__penumbra__lane_close`. Never `git merge --ff-only` from the home checkout.
- Prior art before you start: `mcp__penumbra__memory_search` for the artifact and for the constraint you are about to rediscover.

Related skills: `writing-plans` for the plan document format, `dispatching` for the dispatch contract, `worktree-state-audit` before any land, `verification-before-completion` before any completion claim.

## Filing task drafts (stumble-filing)

For plan-to-dispatch work, treat a stumble as any refuted claim worth revisiting, any gap the recon found outside the plan's scope, or any trap that deserves a permanent guard.
Before filing, search `memory_search` for a similar pending task or existing draft and skip filing when the same work is already tracked.
If the stumble is still new, file it immediately with `mcp__penumbra__memory_observe` so it is not lost when the plan closes.
Use `event_type: 'task_draft'` and include a fresh UUID v4 `draft_id`, a one-paragraph `prompt`, at least one `affects_projects` entry, and an `evidence` object with whatever `conv_ids`, `commits`, `files`, and `session_id` you have.
Set `auto_ok: false` by default; only set it to `true` for trivially safe items that do not need review.
Always set `filed_by_agent` to your agent name, `filed_via: 'skill_inline'`, and `parent_draft_id: null`.
Keep the filing short and concrete, then return to the pipeline.
