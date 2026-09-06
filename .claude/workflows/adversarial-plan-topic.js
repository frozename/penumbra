// CC-optimized adversarial-plan for ONE topic. Reusable: run once per topic.
//   Workflow({ scriptPath: '.claude/workflows/adversarial-plan-topic.js',
//              args: { label: 'my-topic', spec: '<the planning spec markdown>',
//                      personas?: [{name, prompt}, ...] } })
// Fans out N persona lenses (CC subagents, sonnet) over args.spec in parallel,
// then synthesizes one prioritized phased TDD plan (opus). Returns { ok, label, personas, plan, failed }.
export const meta = {
  name: 'adversarial-plan-topic',
  description: 'CC adversarial-plan for one topic (args.spec): persona lenses draft phased TDD plans in parallel, then synthesize.',
  phases: [
    { title: 'Plan', detail: 'persona lenses draft phased TDD plans in parallel' },
    { title: 'Synthesize', detail: 'merge into one prioritized phased TDD plan' },
  ],
}

const DEFAULT_PERSONAS = [
  { name: 'architect', prompt: 'You are a systems architect. Plan with package boundaries, contracts, schema decisions, and cross-cutting concerns front-of-mind. Surface the integration surface area before the implementation steps.' },
  { name: 'simplifier', prompt: 'You are an anti-overengineering simplifier. Plan the smallest scope that ships value. Aggressively delete speculative generality and premature abstraction. If a phase can be skipped, skip it. Challenge whether each scope item is even needed yet.' },
  { name: 'risk', prompt: 'You are a risk-focused planner. Plan with race conditions, security boundaries, rollback paths, and observability front-of-mind. Each phase declares which failure modes it could introduce and how to detect them.' },
  { name: 'integration', prompt: 'You are an integration planner. Plan around daemon restarts, schema migrations, MCP federation, multi-package fanout, registry mutations. Each phase names which services need a restart and which env vars / yaml blocks change.' },
]

const OUTPUT_INSTR = '\n\n## Output\nProduce a phased TDD plan from YOUR bias. Markdown, numbered phases. Each phase: failing test (name + assertion + file path) -> impl (smallest code, concrete file paths) -> verify (exact command). Note package boundaries, schema/flag deltas, and which services need a restart. End with a Trade-offs section. Do not implement; output only the plan.'

let __args = args
if (typeof __args === 'string') {
  try {
    __args = JSON.parse(__args)
  } catch (err) {
    throw new Error('adversarial-plan-topic: args is not valid JSON: ' + (__args.length > 300 ? __args.slice(0, 300) + '...' : __args))
  }
}
if (!__args || typeof __args !== 'object') __args = {}
const spec = typeof __args.spec === 'string' ? __args.spec : ''
const label = typeof __args.label === 'string' ? __args.label : 'topic'
const personas = (Array.isArray(__args.personas) && __args.personas.length) ? __args.personas : DEFAULT_PERSONAS
if (!spec) {
  // Fail fast instead of fanning out personas on an empty topic.
  return {
    ok: false,
    error: 'adversarial-plan-topic: empty spec — args did not arrive',
    args_type: typeof args,
    args_preview: typeof args === 'string' ? args.slice(0, 300) : JSON.stringify(args === undefined ? null : args).slice(0, 300),
  }
}

phase('Plan')
const draftThunks = personas.map((p) => () =>
  agent(`${p.prompt}\n\n${spec}${OUTPUT_INSTR}`, { label: `${label}:${p.name}`, phase: 'Plan', model: 'sonnet' })
    .then((body) => ({ persona: p.name, body })),
)
const drafts = (await parallel(draftThunks)).filter((d) => d && d.body)
const failed = personas.length - drafts.length
log(`${label}: drafted ${drafts.length}/${personas.length} persona plans`)

if (drafts.length === 0) {
  return {
    ok: false,
    error: 'adversarial-plan-topic: all persona lenses failed',
    label,
    personas: [],
    failed,
    plan: null,
  }
}

phase('Synthesize')
const block = drafts.map((d) => `### ${d.persona}\n\n${d.body}`).join('\n\n')
const synthPrompt = [
  `You are merging ${drafts.length} planner outputs (lenses: ${drafts.map((d) => d.persona).join(', ')}) into ONE prioritized phased TDD plan for: ${label}. Synthesis only.`,
  '',
  '## Plans',
  block,
  '',
  '## Synthesis instructions',
  '1. Merge overlapping steps into one.',
  '2. Where planners conflict, name the conflict and pick the winner with a one-sentence justification.',
  '3. Include gaps only one lens caught (especially risk/integration hazards).',
  '4. Output ONE phased TDD plan: numbered phases, each failing-test -> impl -> verify (exact file paths + commands), package boundaries, flag/schema deltas, restart instructions; mark each phase independent (parallelizable) or sequential.',
  '5. Order phases by leverage: unblocks-most-other-work, then safety-criticality, then cost.',
  '6. End with Trade-offs (what was cut + why) and Open questions (anything needing the operator before implementation).',
  'The merged plan must be SMALLER than the sum of inputs. Prefer the simplifier scope where defensible; prefer risk/integration items where they flag a real hazard. Additive + reversible + flag-gated. Repo text neutral. Output as markdown.',
].join('\n')
const plan = await agent(synthPrompt, { label: `synth:${label}`, phase: 'Synthesize', model: 'opus' })

const ok = failed === 0 && !!plan
return { ok, label, personas: drafts.map((d) => d.persona), plan, failed }
