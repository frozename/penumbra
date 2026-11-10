# Workflow efficacy, efficiency and portability review

Companion to `workflow-dispatch-review-plan.md` (correctness/reliability). This document covers: what each workflow costs and delivers, how to measure that, and how to make the Claude-Code-only workflows available to every harness with CC reduced to a thin layer. Read-only review; file:line references are against the commit this doc lands on.

## 1. Executive summary

1. **Two runtimes, one job.** Penumbra has a daemon workflow runtime (`packages/workflows`, 6 TS workflows + 9 playbooks, callable by every harness via `workflow_run`) and a second orchestration layer in `.claude/workflows/*.js` (17 scripts, ~123 KB of prompt/control literals, CC-only). Only 3 of the 17 CC scripts delegate to the native runtime; 9 hand-roll `chain_start → chain_wait → chain_get_response` — the pattern AGENTS.md tells everyone else not to use.
2. **The CC layer is the expensive layer.** Every fleet dispatch made from a CC script runs through a CC subagent ("dispatch proxy") whose context is the full self-contained prompt (`penumbra-fanout.js` alone carries ~15 KB of literals) and whose *entire result* flows back into the orchestrator session. Native TS workflows write persona/results to files via `ctx.fileWrite` and return one synthesis. For an N-way fan-out the CC path re-reads N full results into the top-level context; the native path reads one.
3. **Efficacy is unmeasurable today.** `workflow.outcome` records outcome + latency but no tokens/cost (`packages/workflows/src/capture.ts:43-48` inserts T0 rows with the usage columns null). The join key exists — every workflow-issued `chain_start` carries `workflow_run_id` (`packages/workflows/src/ctx.ts:217-219`, `packages/core/src/writers/handoff.ts:171,201`) — but nothing reads it back. Build the `workflow_report` join first; everything else in this doc can then be argued with numbers.
4. **Porting is cheap because `WorkflowCtx` already has the primitives.** `ctx.dispatch / awaitChain / cancel / fileWrite / db` (`packages/workflows/src/ctx.ts:16-44`) are exactly what the CC scripts hand-roll. What is missing is a small set of ctx extensions (nested `runWorkflow`, run-level deadline, progress, `inspectWorktree`, memory search/observe) and a *generic* CC shim. Estimated ~3 sessions for the fan-out family, ~1 session for the shim + report.

## 2. Where the tokens go

| Cost centre | Evidence | Assessment |
| --- | --- | --- |
| CC dispatch-proxy per task | `penumbra-fanout.js:270-304`; AGENTS.md "Claude Code dynamic workflows" section — each `agent()` is a subagent that brokers one chain | Per fleet task: proxy system prompt + fanout literals (~15 KB static upper bound) + tool-call transcript for `chain_start`, N×`chain_wait`, `chain_get_response`, `chain_get_messages`, `handoff_get`, `dispatch_audit`. `haiku` by default keeps $ low but not context: the result text is returned to the orchestrator verbatim. |
| Result echo into orchestrator | `penumbra-fanout.js` returns all results; `penumbra-tournament.js:214-249`, `penumbra-fix-until-green.js:397-452`, `penumbra-loop-discover-to-green.js:268-582` consume them in the session model | The most expensive model in the stack (session model) reads every worker's full response. Native workflows avoid this (`adversarial-review/workflow.ts:875-912` writes persona output to files, returns only `synthesis.md`). |
| Hand-rolled polling | `penumbra-fanout.js`, `-fleet-verify.js:206-265`, `-token-opt-*.js` | Each `chain_wait` round-trip is a tool call in a subagent turn; a 30-min dispatch with bounded waits is dozens of tool calls per task. Native `ctx.awaitChain` polls in-process with 200 ms→2 s backoff (`ctx.ts:283-306`) at zero token cost. |
| Recall budgets | `recall.ts:43-47` default 8 000 tokens; `adversarial-review` 24 000 (`:158-172`), `adversarial-plan` 12 000, `maestro-context-prime` 12 000 on **every** `session-start` | `maestro-context-prime` + `memory-digest` + `session-handoff` state-threshold triggers can together inject >20 K tokens into a session before the user types. Worth an A/B: halve `maestro-context-prime` and measure `session-handoff` quality via the report in §4. |
| Persona fan-out width | `adversarial-review` N personas + synthesis, ≤2N+3 dispatches with retries (`:915-1000`, `:1048-1138`); plan ≤2N+2 | Fine in principle; the missing piece is a run-level deadline (each wait is an independent 30 min) and a per-run cost cap. |
| Duplicated prompts | `adversarial-plan-integration.js` / `adversarial-plan-topic.js` re-implement persona prompts that `plugin/workflows/adversarial-plan` already routes via `_shared/pool-resolver` | Two prompt sets to tune; only the native one has capture/quarantine (`workflow_stats`, `capture.ts:122-180`). |
| Lifecycle noise | `dispatch-drift-guard` (post-tool-use on every Edit/Write/Bash, `:77-89`), `session-memory-sweep` (pre-compact + stop, 90 s HTTP call) | Both are 0-dispatch and cheap; keep. `dispatch-drift-guard` reminder text still says "use `workflow_run` or CC fanout" — after §5 it should say only `workflow_run`. |

## 3. Per-workflow efficacy assessment

### Native (portable) — `plugin/workflows` + `plugin/playbooks`

| Workflow | Value | Efficiency | Quality risks | Verdict |
| --- | --- | --- | --- | --- |
| `adversarial-review` | High — the only quality gate with pass-rate semantics (`success_partial` ≥80 %) and capture | Good: files not echo; pool-resolver routing | No run-level deadline; synthesis retries ×3 can triple wall time; 1 226-line file | Keep; add deadline + cost cap; split file |
| `adversarial-plan` | High | Good | Same deadline issue; duplicates review's fan-out loop (`:407-468` vs review `:915-1000`) | Keep; extract shared fan-out (§5.2) |
| `session-handoff` / `-draft` / `-stop` | High (continuity) | `-draft` = 1 dispatch, 120 s | Alphabetical ordering dependency between `session-handoff` and `-draft` (`routes/workflows.ts` trigger loop) | Keep; make ordering explicit |
| `session-memory-sweep` | Medium-high | 0 dispatches, one 90 s HTTP call | `max_candidates` off-by-one (`:433-437`) | Keep |
| `memory-digest` | Medium | 0 dispatches | Runs every session-start; no staleness check visible → consider skipping when digest unchanged | Keep, add short-circuit |
| `maestro-context-prime` | Medium | 12 K recall every session-start | Largest fixed per-session cost; unmeasured benefit | Measure, then likely trim to ~6 K |
| `dispatch-drift-guard` | Medium | trivial | Text references CC fanout | Keep, reword |
| `delegate-suggest`, `file-context`, `prompt-classify`, `brainstorm`, `write-plan` | Low-medium, on-demand | 0 dispatches, ≤1 500 recall (brainstorm/write-plan undeclared → 8 000 default) | Declare budgets explicitly on the two undeclared ones | Keep |
| `session-summarize` | Medium | 8 000 recall on every `stop` | Filed stumbles run after every matched `stop` workflow serially | Keep |

### CC-only — `.claude/workflows`

Static literal bytes are an upper bound on injected prompt text (labels/schemas included; runtime args, file contents, recall and results excluded).

| Script | Pattern | Literal bytes | Native equivalent | Efficacy verdict |
| --- | --- | ---: | --- | --- |
| `penumbra-fanout.js` | hand-rolled chain lifecycle | 15 007 | none | Core primitive of the family; **port first** (§5.1) |
| `penumbra-loop-discover-to-green.js` | nested fanout + review, fix loop inlined because CC nesting is 1-level (`:44-48`) | 21 845 | none (`plugin/skills/loop-discover-to-green` is a skill, not a workflow) | Highest token cost in the repo; becomes a ~150-line TS workflow once fan-out + nested `runWorkflow` exist |
| `penumbra-fix-until-green.js` | `workflow('penumbra-fanout')` + local grader | 11 132 | none | Port; grader becomes one `ctx.dispatch` |
| `penumbra-fleet-verify.js` | hand-rolled | 10 245 | none | Port as fan-out + verify schema |
| `adversarial-review.js` | `workflow_run` + optional hand-rolled fix path (`:202-273`) | 9 586 | `adversarial-review` | Already thin for the review; fix path should call the ported fix-until-green |
| `adversarial-plan-integration.js` | pure prompt, hard-coded 2024 migration facts (`:24-35`) | 8 850 | `adversarial-plan` | **Stale**; delete |
| `penumbra-token-opt-batch.js` | hand-rolled + in-workflow land | 6 818 | none | Contradicts "never lands" doc; superseded by fleet-verify + `land` skill → delete after port |
| `penumbra-token-opt-migrate.js` | hand-rolled; instructs non-existent `dispatch_land(rebase=true)` (`:180-185`) | 6 199 | none | **Stale**; delete |
| `penumbra-swarm.js` | planner agent + `workflow('penumbra-fanout')` | 6 335 | none | Port: planner = 1 dispatch, then fan-out |
| `land-and-close.js` | agent-mediated `dispatch_land` / `lane_close` / `task_*` | 4 642 | none | Keep CC-side (needs human approval mid-run); or port with `output: task` sink |
| `penumbra-review-sweep.js` | `workflow_run(wait=false)` per target | 4 559 | `adversarial-review` | Already thin; becomes `args.targets[]` on the native review |
| `integration-audit.js` | pure prompt, hard-coded criteria (`:51-59`) | 4 503 | none | Stale; delete or convert to playbook |
| `penumbra-tournament.js` | fanout + judge with `worktree_inspect` | 3 322 | none | Port once `ctx.inspectWorktree` exists |
| `adversarial-plan-topic.js` | pure prompt, hard-coded personas (`:53-58`) | 3 091 | `adversarial-plan` | Delete; use native |
| `penumbra-research.js` | memory prime → web → synth → `memory_observe` | 2 883 | none | Web access is harness-specific; port the memory bookends, keep web step as a pluggable dispatch to an agent with web tools |
| `session-first-moves.js` | 1 collector agent | 2 372 | none | Convert to a playbook (0 dispatches) |
| `session-memory-sweep.js` | `workflow_run(wait=true)` + approval | 1 729 | `session-memory-sweep` | Thin already; `wait=true` is the watchdog-unsafe form the other wrappers avoid — switch to `wait=false` + `workflow_wait` |

Net: 4 scripts are dead/stale and can be deleted now (`adversarial-plan-integration`, `adversarial-plan-topic`, `penumbra-token-opt-migrate`, `integration-audit`), 3 are already thin, 10 need a native port.

## 4. Measuring efficacy (do this first)

Data already present:

- `workflow.run` / `workflow.recall` / `workflow.outcome` T0 rows with `workflow_name`, `outcome`, `latency_ms`, `artifacts`, `gate_evidence` (`capture.ts:88-120`); `workflow_stats` rollup with quarantine (`schema.ts:491-505`).
- `handoffs.workflow_run_id` (`writers/handoff.ts:171`) → `agent_performance` (`cost_usd`, `tokens_used`, `latency_ms`, `framework_overhead_ms`, reliability flags; `schema.ts:321-358`) and `dispatch_events` `wall_ms`.
- `quality.status` already reads adversarial-review outcomes but hard-codes the name (`readers/quality-status.ts:102-109`); `cost.recent` has no `workflow_name`.

Proposal — `workflow.report` (daemon route + MCP tool, read-only):

```sql
-- per workflow_name over a window
SELECT o.workflow_name,
       COUNT(*)                                   AS runs,
       SUM(o.outcome = 'success')                 AS ok,
       AVG(o.latency_ms)                          AS p50_latency_ms,   -- use percentile in code
       COUNT(h.id)                                AS dispatches,
       SUM(ap.cost_usd)                           AS cost_usd,
       SUM(ap.tokens_used)                        AS tokens,
       AVG(ap.reliability_ok)                     AS reliability
FROM workflow_outcomes o                          -- view over t0_events event_type='workflow.outcome'
LEFT JOIN handoffs h            ON h.workflow_run_id = o.workflow_run_id
LEFT JOIN agent_performance ap  ON ap.handoff_id = h.id
GROUP BY o.workflow_name;
```

Prerequisites: (a) add `workflow_run_id` to the `workflow.outcome` payload (it is known in `routes/workflows.ts` at capture time, not yet emitted); (b) a generated column or index for `workflow_name` instead of `json_extract` (also fixes the `workflow.history` scan noted in the companion doc). Add the same numbers as a "Workflows" panel in the console mission view.

Quality signals worth recording per run, none of which exist today: recall tokens actually consumed vs budget; persona pass-rate (review already computes it; emit it); whether the produced artifact was *used* (handoff draft superseded vs consumed; synthesis landed vs discarded) — the latter via `task`/`lane` linkage.

## 5. Making CC-only workflows universal; CC as a thin layer

### 5.1 Target architecture

```
harness (CC / Gemini / Codex / OpenCode / devin acp)
  └─ MCP: workflow_run(name, args, cwd, wait=false) → workflow_wait(id) → read_handle
        └─ daemon: packages/workflows runtime
              ├─ plugin/workflows/fanout          (new; generic N-task fan-out, files not echo)
              ├─ plugin/workflows/fix-until-green (new; uses ctx.runWorkflow('fanout'))
              ├─ plugin/workflows/tournament      (new; uses ctx.inspectWorktree)
              ├─ plugin/workflows/swarm           (new; planner dispatch → fanout)
              ├─ plugin/workflows/fleet-verify    (new)
              ├─ plugin/workflows/discover-to-green (new; composes the above)
              ├─ plugin/workflows/research        (new; memory bookends, web step delegated)
              └─ adversarial-review / -plan / session-* (existing)
CC thin layer (.claude/workflows/):
  penumbra.js  — ONE generic shim: Workflow({args:{name, args, repo}}) → workflow_run(wait=false)
                 → bounded workflow_wait loop → render summary (+ read_handle for spill)
  land-and-close.js — stays CC (needs interactive approval)
```

CC keeps only what genuinely needs the CC session: interactive approval (`land-and-close`), `WebSearch/WebFetch` when the fleet agent lacks web, and rendering. Everything that is control flow moves into the daemon, where it is (a) available to every harness, (b) free of the 1-level nesting and 16-agent caps, (c) captured in `workflow_stats`, (d) not paying session-model tokens for polling and result echo.

### 5.2 Runtime additions required (all in `packages/workflows`)

| Addition | Why | Where |
| --- | --- | --- |
| `ctx.runWorkflow(name, args, {deadlineMs})` | swarm/tournament/fix-until-green/discover-to-green compose fan-out; CC can only nest one level, the daemon can nest arbitrarily with a depth cap | `ctx.ts` + `exec.ts`; reuse `workflowRuns` registry so children get their own `workflow_run_id` (parent id in payload) |
| Run-level deadline threaded into `dispatch`/`awaitChain` | today every wait is independently 30 min | `ctx.ts:271-306`; `BuildWorkflowCtxDeps.deadlineMs`; `awaitChain` uses `min(timeoutMs, remaining)` |
| `ctx.progress(event)` | CC shim and console need per-task status without polling files | write `workflow.progress` T0 rows; `workflow.status` route returns last N |
| `ctx.inspectWorktree(handoffId)` | tournament judge, fleet-verify, fix-until-green grader | wrap the existing `worktree_inspect` implementation used by MCP |
| `ctx.memory.search / observe` | research, swarm planner priming | wrap existing recall/observe services |
| Shared `_shared/fanout.ts` | remove the duplicated persona loop in plan/review (`plan:407-468,510-537`; `review:915-1000,1048-1130`) and give the new workflows one retry/timeout/cancel implementation | `plugin/workflows/_shared` |
| Per-run cost cap | `ctx.dispatch` refuses when Σ `agent_performance.cost_usd` for the run exceeds `args.max_cost_usd` | needs §4 join |
| Typed args schema exposed by `workflow.list` | non-CC harnesses need to discover `args` shape; today only CC scripts document it in `meta` | add `args_schema` (zod→JSON schema) to `WorkflowSpec` |

### 5.3 Porting order (effort in Devin sessions)

1. `workflow.report` + `workflow_run_id` in outcome payload + `args_schema` in `workflow.list` — **1 session**. Gives a baseline before/after.
2. `_shared/fanout.ts` + `plugin/workflows/fanout` + ctx deadline/progress; refactor plan/review onto it; generic `penumbra.js` shim; delete the 4 stale scripts — **1–2 sessions**.
3. `fix-until-green`, `fleet-verify`, `swarm` (need `ctx.runWorkflow`, `ctx.inspectWorktree`) — **1 session**.
4. `tournament`, `discover-to-green`, `research` (memory bookends) — **1 session**.
5. Delete the ported `.claude/workflows/penumbra-*.js`, rewrite the AGENTS.md "Claude Code dynamic workflows" section to describe the shim, reword `dispatch-drift-guard` — **<1 session**.

### 5.4 Risks / decisions needed

- **Approval gate.** CC fan-out uses `trust_mode: all` because a background script can't surface approvals. Native workflows have the same constraint; the daemon already has `handoff.approve`. Decision: keep `all` for STANDARD/TRIVIAL (status quo) and add `output: task` for BOUNDARY items so a human approves via the task queue rather than mid-run.
- **Web access for `research`.** Only harness-side. Model it as `ctx.dispatch({agent: <seat with web tools>})` and leave a CC fast-path in the shim when the fleet has no web-capable seat.
- **`workflow_run(wait=true)` watchdog.** The shim must always use `wait=false` + `workflow_wait` (the pattern `adversarial-review.js:165-175` already uses); `session-memory-sweep.js:123-128` should be fixed the same way.
- **Long runs and `workflow_runs` TTL/spill.** `discover-to-green` can run for hours; confirm `workflow-runs-registry` TTL (results are purged on status/wait) exceeds the run-level deadline, or persist final artifacts to files and return paths.
