export const meta = {
  name: 'integration-audit',
  description:
    'Audit whether penumbra-maestro and CC ultracode/Workflow are mutually integrated: protocol present, guard hook wired+correct, lifecycle workflow valid, and the two reinforce (not fight) each other. Read-only.',
  phases: [
    { title: 'Probe', detail: 'parallel read-only checks of each integration surface' },
    { title: 'Synthesize', detail: 'one integration verdict + gaps' },
  ],
}

phase('Probe')

const REPO = ((typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {})).repo) || (typeof process !== "undefined" ? (process.env.PENUMBRA_REPO || process.cwd()) : ".")
const HOME = "~"

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['surface', 'present', 'wired', 'evidence', 'gaps', 'score'],
  properties: {
    surface: { type: 'string' },
    present: { type: 'boolean', description: 'does the artifact exist' },
    wired: { type: 'boolean', description: 'is it actually active/loaded, not just present' },
    evidence: { type: 'string', description: 'verbatim file paths / line snippets / command output proving it' },
    gaps: { type: 'string', description: 'concrete missing pieces or "none"' },
    score: { type: 'integer', description: '0-10 how well this surface integrates the two systems' },
  },
}

const PROBES = [
  {
    key: 'protocol',
    prompt: `Read ${HOME}/.claude/CLAUDE.md. Confirm whether an "Anti-fabrication protocol" section exists and is loaded every turn (global CLAUDE.md is always in context). Report its concrete rules verbatim. surface="anti-fabrication-protocol". wired=true only if it is in the GLOBAL ~/.claude/CLAUDE.md (always loaded), not a project file.`,
  },
  {
    key: 'guard',
    prompt: `Inspect ${HOME}/.claude/hooks/penumbra-agent-gc-guard.sh AND ${HOME}/.claude/settings.json. Confirm: (a) the guard script exists and has Safe(1) ancestor, Safe(2) diff-empty, Safe(3) own-files-in-main checks; (b) it is WIRED into settings.json hooks.PreToolUse with a "Bash" matcher (grep for penumbra-agent-gc-guard). Report the matcher list and the guard's three safe-conditions verbatim. surface="data-loss-guard-hook". wired=true only if referenced in settings.json PreToolUse.`,
  },
  {
    key: 'lifecycle',
    prompt: `Read ${REPO}/.claude/workflows/penumbra-token-opt-migrate.js. Confirm it (a) parses args when args is a JSON string, (b) dispatches via a sub-agent that returns a schema-validated object (DISPATCH_SCHEMA), (c) verifies via a second schema (VERIFY_SCHEMA), (d) does NOT auto-land (returns a land_hint instead). Quote the schema field names. surface="cc-workflow-lifecycle". wired=true if the script is syntactically a valid Workflow (has meta + phase/agent calls) and returns structured data.`,
  },
  {
    key: 'evidence',
    prompt: `Run: cd ${REPO} && git log --oneline -8. Confirm how many recent commits are token-opt envelope migrations landed THIS session (dispatch_timeline, chain_history, reconciler_verdicts, chain_list_agents+dispatch_audit, permission_get, fs_grep, fs_glob). These are the proof the CC-Workflow-drives-penumbra-fleet loop actually produced landed, pushed, verified work. surface="proof-of-loop". wired=true if >=3 such commits are on main. Quote the commit subjects.`,
  },
  {
    key: 'reinforce',
    prompt: `Assess whether CC ultracode/Workflow and penumbra ENHANCE each other vs fight. Consider: ultracode's standing instruction is "use the Workflow tool for substantive tasks". The integration routes that into .claude/workflows/penumbra-token-opt-migrate.js which drives the penumbra fleet (chain_start -> codex-acp-deep) and returns schema-validated data so the orchestrator reports from data not prose. Penumbra contributes: agent_recommend routing, verdict-gated dispatch_land, lane ledger, worktree isolation. CC contributes: deterministic JS control flow, StructuredOutput schema validation, parallel fan-out. Identify where they reinforce and any place they still conflict (e.g. ultracode pushes MORE parallelism while the anti-fabrication rule wants fewer concurrent dispatch-lifecycle steps). surface="mutual-reinforcement". Score how well integrated. Be specific and critical.`,
  },
]

const findings = await parallel(
  PROBES.map((p) => () =>
    agent(p.prompt + `\n\nReturn the structured finding. Every evidence string must be copied from a real file read or command output this turn — never invented.`, {
      label: `probe:${p.key}`,
      phase: 'Probe',
      schema: FINDING_SCHEMA,
      agentType: 'Explore',
      model: 'sonnet',
    }),
  ),
)

const real = findings.filter(Boolean)

phase('Synthesize')

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['integrated', 'overall_score', 'summary', 'reinforcements', 'remaining_gaps', 'recommended_next'],
  properties: {
    integrated: { type: 'boolean', description: 'true iff all critical surfaces are present AND wired' },
    overall_score: { type: 'integer', description: '0-100 integration completeness' },
    summary: { type: 'string' },
    reinforcements: { type: 'array', items: { type: 'string' }, description: 'concrete ways the two systems augment each other' },
    remaining_gaps: { type: 'array', items: { type: 'string' }, description: 'concrete remaining gaps, each actionable' },
    recommended_next: { type: 'array', items: { type: 'string' } },
  },
}

const synth = await agent(
  [
    `Synthesize an integration verdict from these per-surface findings (JSON):`,
    JSON.stringify(real, null, 2),
    ``,
    `Decide: are penumbra-maestro and CC ultracode/Workflow FULLY integrated and mutually augmenting? "integrated" = every critical surface (protocol, guard, lifecycle, proof-of-loop) is present AND wired. List concrete reinforcements and any remaining gaps (e.g. the guard override env-var being unreachable from the hook process; ultracode parallelism pressure vs one-lifecycle-step-per-turn). Be honest and specific — do not inflate the score.`,
  ].join('\n'),
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: 'opus' },
)

return { findings: real, synthesis: synth }
