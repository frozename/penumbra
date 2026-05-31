export const meta = {
  name: 'adversarial-plan-integration',
  description:
    'Adversarial planning: 5 planner personas (architect, simplifier, test-first, risk, integration) draft a phased TDD plan for the ultracode<->penumbra augmentation backlog through distinct lenses in parallel, then a synthesizer merges them into one prioritized phased TDD plan. Returns the merged plan text.',
  phases: [
    { title: 'Personas', detail: '5 lenses draft plans in parallel' },
    { title: 'Synthesize', detail: 'merge into one prioritized phased TDD plan' },
  ],
}

const SPEC = `# Topic
Maximize the mutual augmentation between CC ultracode/Workflows and penumbra-maestro — more parallelism/throughput WITHOUT reintroducing the fabrication or data-loss failure modes seen this session. Produce one prioritized, phased TDD plan.

# Context (this session, all verified)
- Anti-fabrication system built: (1) ~/.claude/CLAUDE.md "Anti-fabrication protocol" (7 hard rules: never narrate a result the same turn as the call; copy IDs/SHAs verbatim; one dispatch-lifecycle step per turn; land-before-teardown; single-token verification; prefer codified lifecycle; correct-don't-confabulate). (2) ~/.claude/hooks/penumbra-agent-gc-guard.sh wired into PreToolUse(Bash) — blocks force-delete/remove of agent/<uuid> refs unless content is in main (3 safe checks: tip ancestor-of-main; full git diff branch..main empty; branch's OWN files diff empty for the squash + stale-base cases); fail-open on uncertainty. (3) CC Workflow lifecycle scripts (.claude/workflows/penumbra-token-opt-migrate.js single, penumbra-token-opt-batch.js batch) where each agent() returns schema-validated data so dispatch/land outcomes are never hand-narrated.
- Proven loop: 8 MCP tools migrated to envelope opt-in and landed via CC-Workflow -> penumbra-fleet (codex-acp-deep) -> dispatch_land: dispatch_timeline, chain_history, reconciler_verdicts, chain_list_agents, dispatch_audit, permission_get, fs_grep, fs_glob. origin/main == HEAD == a8e327b6.
- penumbra-token-opt-batch.js written but NOT yet run: fan out dispatch+verify across N tools in PARALLEL, then land each verified branch SEQUENTIALLY (serialize only the git-write on main).
- Integration audit verdict: integrated, 88/100. Held below per-surface 9-10s by real seams found in verified hook source.

# Scope to plan (prioritize + sequence; surface dependencies, independence, and per-item risk)

## A. THROUGHPUT / PARALLELISM (free ultracode)
A1. Validate + harden penumbra-token-opt-batch.js (parallel dispatch+verify, sequential land). Risk: concurrent dispatch_land racing rebase+squash on main.
A2. penumbra dispatch_land_batch([handoff_ids]) primitive that serializes git writes internally, so the fleet runs fully parallel while penumbra owns land ordering.
A3. Runtime interlock that refuses 2 concurrent dispatch-lifecycle steps (convert anti-fab rule 3 from prose to enforced) so parallelism can't reintroduce fabrication.

## B. GUARD HARDENING (audit gaps, found in verified source)
B4. Fix the override: read PENUMBRA_ALLOW_AGENT_GC from the parsed hook payload / a sentinel file, not the hook process env (inline VAR=1 prefix sets it on the tool subprocess, not the separately-spawned hook).
B5. Broaden the destruction matcher from syntax to ref-deletion INTENT: git update-ref -d, git push origin :ref / --delete, rm -rf of a worktree dir, aliases.
B6. Regression test suite for penumbra-agent-gc-guard.sh: unlanded->block(exit2); ancestor->allow; squash-empty-diff->allow; stale-base own-files-empty->allow; fail-open (no jq/no repo/branch absent)->exit0; override honored.
B7. Smoke tests for the lifecycle/batch workflow scripts: args JSON-string parse; MISSING-branch early return; land_hint shape; no-auto-land guarantee.

## C. PENUMBRA-SIDE FRICTION (observed this session)
C8. dispatch_land teardown is a no-op that reports worktree_torn_down:true but leaves orphaned worktree dirs + branches (node_modules symlinks to MAIN checkout — deleting naively can wipe main's deps). Make it actually tear down symlink-safe and report truthfully.
C9. MCP invocation capture records origin="unknown" for ALL rows -> blocks Phase-2 frequency-weighted migration ranking. Populate real origin (maestro vs fleet-worker vs sub-agent) at the sink.
C10. dispatch_land requires commit_message but fails with a raw zod error -> default it to the branch's own commit subject when omitted.
C11. agent_recommend partial-completion blind spot: a 12-tool dispatch that did only 2/12 still counted as completed/accept. Add a contract-completeness signal.
C12. task_type deprecation drift: tests warn 'task_type deprecated; prefer workload' but chain_start MCP schema still advertises task_type.

# Constraints
Keep ultracode ON. Repo text neutral (no AI/assistant authorship). penumbra changes go via the fleet + TDD. Landing stays maestro-owned. Order phases by (a) what unblocks the most other work, (b) safety-criticality, (c) cost. Call out independent (parallelizable) vs sequential items, and which are risky enough to need their own review.`

const OUTPUT_INSTR = `\n\n## Output\nProduce a phased TDD plan from YOUR bias. Markdown. Number the phases. For each phase: failing test -> impl -> verify, with concrete file paths, package boundaries, schema deltas, daemon restarts. Note which scope items (A1-A3,B4-B7,C8-C12) the phase covers, and mark items independent (parallelizable) vs sequential. End with a 'Trade-offs' section. Do not implement; output only the plan.`

const PERSONAS = [
  { name: 'architect', prompt: 'You are a systems architect. Plan with package boundaries, contracts, schema decisions, and cross-cutting concerns front-of-mind. Surface the integration surface area before the implementation steps. Favor structural clarity over micro-optimization.' },
  { name: 'simplifier', prompt: 'You are an anti-overengineering simplifier. Plan the smallest scope that ships value. Aggressively delete speculative generality, premature abstraction, and future-proofing that no one asked for. If a phase can be skipped, skip it. Three similar lines beat one abstraction. Challenge whether A2/A3 are even needed yet.' },
  { name: 'test-first', prompt: 'You are a TDD planner. Every phase MUST start with a failing test: name the test, the assertion, and the file path. The impl step is the smallest code that makes it pass. The verify step names the exact command. Pay special attention to B6/B7 (testing the safety machinery itself).' },
  { name: 'risk', prompt: 'You are a risk-focused planner. Plan with security boundaries, perf cliffs, race conditions, rollback paths, and observability front-of-mind. Each phase declares which failure modes it could introduce and how to detect them. Scrutinize A1/A2 (concurrent git writes on main) and B4/B5 (guard bypass surface) hardest.' },
  { name: 'integration', prompt: 'You are an integration planner. Plan around daemon restarts, schema migrations, MCP federation, multi-package fanout, registry mutations, strict-mode toggles. Each phase names which services need a restart and which env vars / yaml blocks change. Focus on C8/C9/C10/C12 (daemon-side dispatch_land + capture + schema).' },
]

phase('Personas')

const plans = await parallel(
  PERSONAS.map((p) => () =>
    agent(`${p.prompt}\n\n${SPEC}${OUTPUT_INSTR}`, { label: `plan:${p.name}`, phase: 'Personas', model: 'sonnet' })
      .then((body) => ({ persona: p.name, body })),
  ),
)

const real = plans.filter((p) => p && p.body)

phase('Synthesize')

const merged = await agent(
  [
    `You are merging ${real.length} planner outputs into ONE prioritized phased TDD plan. The planners worked from different biases (architect, simplifier, test-first, risk, integration).`,
    ``,
    `## Plans`,
    ...real.map((p) => `\n### ${p.persona}\n\n${p.body}`),
    ``,
    `## Synthesis instructions`,
    `1. Merge overlapping steps into one.`,
    `2. Where planners conflict (e.g. simplifier wants to cut a phase the architect added), name the conflict and pick the winner with a one-sentence justification.`,
    `3. Include gaps one planner caught that others missed (especially risk/integration items).`,
    `4. Output one phased TDD plan: numbered phases, each with failing-test -> impl -> verify, concrete file paths, package boundaries, schema deltas, restart instructions. For each phase list which scope items (A1-A3, B4-B7, C8-C12) it covers and whether its dispatches are independent (parallelizable) or sequential.`,
    `5. Order phases by: (a) unblocks-most-other-work, (b) safety-criticality, (c) cost. Put the batch-workflow validation (A1) and guard override fix (B4) early since they gate safe parallelism.`,
    `6. End with 'Trade-offs' (what was cut and why) and 'Open questions' (anything needing user input).`,
    `The merged plan should be SMALLER than the sum of inputs. Prefer the simplifier's scope when defensible; prefer risk/integration items when they identify a real hazard. Keep repo-facing text neutral (no AI authorship).`,
  ].join('\n'),
  { label: 'synthesize', phase: 'Synthesize', model: 'opus' },
)

return { personas: real.map((p) => p.persona), failed: PERSONAS.length - real.length, plan: merged }
