# Scoping spec — Port adversarial-review to a CC Workflow

> Status: **SCOPING ONLY** (design + phased plan; no implementation). Authored 2026-05-31.
> Trigger: question — "what if we migrate adversarial review to a workflow." Motivated by a
> live BOUNDARY gate this session (run `8e249508`) where the 8-persona fan-out caught 3 HIGH
> findings that a fleet code-review verifier + a maestro diff audit + a consumer-binding sweep
> all missed — confirming the review's value, while exposing that its output is prose
> (`synthesis.md`) the maestro must parse rather than typed data.

## 1. Terminology — two distinct workflow runtimes

There are **two** "workflow" engines in play; the question is about moving between them.

| | **Penumbra workflow engine** | **CC Workflow tool** |
|---|---|---|
| Code | `packages/workflows` + `plugin/workflows/<name>/workflow.ts` | `.claude/workflows/<name>.js` |
| Author form | TS-function workflow (`spec`, `fn`, `inputSchema`), loaded by `loaders/ts.ts` | JS script with `meta` + `agent()`/`pipeline()`/`parallel()` |
| Invoked by | daemon: `mcp__penumbra__workflow_run`, `/slash`, lifecycle triggers | maestro: `Workflow` tool (background task) |
| Personas/config | central penumbra config (`personas`, `workloads.review_adversarial`) | inline in the script (or read from config) |
| Fleet exec | dispatches personas to the agentchat fleet → **`agent_performance` captured** | `agent()` = CC subagent **unless** it calls `chain_start` internally |
| Output | `.penumbra/reviews/<ts>/{persona}.json|.md` + `synthesis.md` (prose) | whatever the script `return`s — can be **schema-validated typed data** |
| Driving | fire-and-wait; maestro parses artifacts after | maestro orchestrates inline, can branch/loop on typed results |

**Today:** adversarial-review lives entirely in the left column. `penumbra-fleet-verify`
(the dispatch+verify lifecycle the maestro uses) lives in the right column and already proves
the pattern that matters: a CC Workflow whose `agent()` steps call `chain_start` to run work on
the **penumbra fleet**, returning **schema-validated** evidence (`DISPATCH_SCHEMA`/`VERIFY_SCHEMA`).

## 2. What the port buys (and the bar it must clear)

**Gains**
- **Typed findings.** Severity counts + per-finding objects come back as validated data
  (e.g. `{ high: Finding[], medium: Finding[], … }`) instead of the maestro grepping
  `synthesis.md` for "HIGH". Directly feeds `lane_close({ metadata: { high_findings, … } })`.
- **Inline lifecycle.** One script can do review → (if HIGH) dispatch fix-round → re-review →
  `lane_close`, with the **2-round cap** and override logic *codified* (today it's hand-driven
  across turns, exactly the drift the `dispatch-quality-gates` skill warns about).
- **Composability + resume.** Lives in `.claude/workflows/` (VCS, editable inline,
  `resumeFromRunId` caches completed personas), composes with other CC workflows.

**Bar it must clear (else the port is a regression)**
- **B1 — Fleet execution + `agent_performance` capture preserved.** Personas MUST run via
  `chain_start` (like `penumbra-fleet-verify`), not as plain CC subagents — otherwise reviewers
  become Anthropic-model agents invisible to `agent_recommend` and the cost ledger.
- **B2 — Single source of persona prompts.** Do not fork a second copy of the persona
  definitions that drifts from penumbra config.
- **B3 — No loss of the slash/lifecycle entry points** that other call sites rely on
  (`/adversarial-review`, `penumbra-review-sweep`, the BOUNDARY gate in `dispatch-quality-gates`).

## 3. Current architecture (as-built, confirmed this session)

- Definition: `plugin/workflows/adversarial-review/workflow.ts` (TS-function workflow:
  `export default spec`, `export { fn, inputSchema }`), bundled+imported by
  `packages/workflows/src/loaders/ts.ts`.
- Inputs: `{ base_ref, target_ref, timeout_ms }` (confirmed in `routes/workflows.test.ts`).
- Personas: config map `personas: { <name>: { preferred_agent, bias, system_prompt,
  category_hints } }`; selection via `workloads.review_adversarial: { eligible_agents,
  fan_out, synthesizer }`.
- Run shape (observed on `8e249508`): 8 personas (architect, security, performance,
  maintainability, devils_advocate, simplicity, naming_clarity, data_correctness) →
  per-persona `{persona}.json` + `.md` → synthesizer agent → `synthesis.md` with YAML
  frontmatter carrying `synthesis_handoff_id` + `persona_handoff_ids` (real fleet handoffs).
- Artifacts dir: `.penumbra/reviews/<ISO-ts>/`.

## 4. Target architecture (hybrid CC Workflow)

`.claude/workflows/adversarial-review.js`, modeled on `penumbra-fleet-verify.js`:

```
meta { name: 'adversarial-review', phases: ['Review','Synthesize','(opt) Fix','(opt) Close'] }
args { target_ref, base_ref?, personas?, focus?, fixRound?, laneId?, taskClass? }

phase('Review')
const diff = <git diff base..target collected by an agent() or passed in>
const findings = await parallel(personas.map(p => () =>
  agent(<persona p: chain_start a fleet review dispatch over `diff`, return FINDINGS_SCHEMA>,
        { label: `review:${p.name}`, phase: 'Review', schema: FINDINGS_SCHEMA })))
  .then(rs => rs.filter(Boolean))

phase('Synthesize')
const synthesis = await agent(<merge findings → SYNTHESIS_SCHEMA: verdict + ranked findings>,
        { schema: SYNTHESIS_SCHEMA })

// optional inline lifecycle (only when args.fixRound + laneId provided)
if (synthesis.high.length && args.fixRound) { … dispatch fix → re-review (cap 2) … }

return { verdict, high, medium, low, synthesis_md_path, persona_handoff_ids }
```

- `FINDINGS_SCHEMA`: `{ persona, findings: [{ id, severity: high|medium|low, file, line,
  title, detail, fix }] }`.
- `SYNTHESIS_SCHEMA`: `{ verdict: land|land_with_revisions|block, shared_concerns,
  contradictions, high|medium|low: Finding[], recommended_actions }`.

## 5. Key design decisions

- **D1 Persona source of truth (B2).** *Recommend:* the CC script reads the penumbra persona
  config (via a small read tool / `daemon_reload_config` surface or a generated JSON), NOT a
  hardcoded copy. Fallback: accept `args.personas` to override. Avoid a forked prompt set.
- **D2 Execution (B1).** *Recommend:* each persona `agent()` calls `chain_start`
  (`task_type: review_adversarial`, the eligible agent from config) and returns the
  schema-validated findings — same pattern as `penumbra-fleet-verify`'s dispatch driver.
  Keeps fleet routing + `agent_performance` + cost capture.
- **D3 Findings as data (primary payoff).** Each persona dispatch returns `FINDINGS_SCHEMA`;
  no `synthesis.md` parsing needed for counts. Still also write the `.md` artifacts for humans.
- **D4 Synthesis.** Keep a synthesizer `agent()` (judgment merge), but its return is
  `SYNTHESIS_SCHEMA` (typed) with the prose `synthesis.md` as a side artifact.
- **D5 Inline lifecycle.** Optional `fixRound`/`laneId` args let the same script run
  review → fix → re-review → `lane_close` with the 2-round cap. Default off (pure review) so
  it can still be a drop-in for `penumbra-review-sweep`.
- **D6 Invocation surface (B3).** Two sub-options:
  - (a) **Coexist** — add the CC workflow; keep the daemon workflow for `/slash` + lifecycle +
    `penumbra-review-sweep`. Maestro uses the CC one for typed-output + inline-lifecycle runs.
  - (b) **Wrap** — daemon workflow becomes a thin shim that the maestro can still `/slash`, but
    the orchestration logic lives in the CC script. Higher effort; single logic path.
  *Recommend (a) first* (lower risk, no break to existing call sites), migrate to (b) only if
  duplication becomes a maintenance cost.
- **D7 Relationship to existing.** Do not delete `plugin/workflows/adversarial-review` in the
  first cut — the BOUNDARY gate, slash, and sweep depend on it. Port additively.

## 6. Risks & mitigations

- **R1 Persona drift** (two copies). → D1: read config, don't fork.
- **R2 Capture loss** (CC subagents bypass `agent_performance`). → D2: `chain_start`-backed
  personas, asserted by a test that the run produced real fleet handoff_ids.
- **R3 Diff collection cost** — a big diff fanned to N personas multiplies tokens. → pass the
  diff once; have personas read a shared diff artifact, not re-collect.
- **R4 Two engines diverge** in behavior/verdict semantics. → share `SYNTHESIS_SCHEMA` +
  golden-fixture test asserting both engines classify the same diff identically.
- **R5 Scope creep into building it now.** → this doc is scoping; build is a separate approved task.

## 7. Phased plan (TDD, when approved)

- **P1** Schemas + persona-config reader. Test: reader returns the 8 personas from config;
  `args.personas` overrides. (no fleet calls)
- **P2** Single-persona dispatch driver (chain_start → `FINDINGS_SCHEMA`). Test against a fixed
  small diff; assert a real fleet handoff_id is captured (R2).
- **P3** Fan-out + synthesizer (`SYNTHESIS_SCHEMA`) + `.md` artifact parity. Golden-fixture
  test vs a known diff; assert verdict + severity buckets (R4).
- **P4** (opt) Inline fix-round + `lane_close` with the 2-round cap. Test the cap stops at 2.
- **P5** Wire invocation: register `.claude/workflows/adversarial-review.js`; decide D6(a) vs (b).
  Validate end-to-end on a real branch diff; compare against the daemon engine's verdict.

## 8. Open questions for the user

1. **D6**: coexist (a) or wrap (b)? (Recommend a.)
2. Should the CC port **subsume** the `dispatch-quality-gates` BOUNDARY gate (i.e. the gate
   calls the CC workflow with `fixRound` on), or stay a pure reviewer the maestro drives?
3. Persona config exposure: is there an existing read path for `personas`/`workloads` the CC
   script can call, or do we add a small `review_personas`-get surface? (Affects D1 effort.)
4. Priority vs. the memory-overhaul plan (WS1b→WS4) — slot this where in the queue?
