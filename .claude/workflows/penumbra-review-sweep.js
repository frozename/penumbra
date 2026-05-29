export const meta = {
  name: 'penumbra-review-sweep',
  description: "Fan out penumbra's native adversarial-review across several targets (one workflow_run per diff / PR / path), in parallel, and collect each synthesis. Wraps the daemon workflow — keeping its persona routing, pass-rate gates, and agent_performance capture — rather than reimplementing it.",
  whenToUse: 'When you want the multi-persona adversarial review run against MULTIPLE targets at once (several PRs, or several diff ranges / files). Pass args.targets = [{ target_ref, base_ref?, focus?, personas?, content_path? }]. Each runs the real penumbra adversarial-review.',
  phases: [{ title: 'Review', detail: 'one penumbra workflow_run(adversarial-review) per target, in parallel' }],
}

// args: { targets: [{ target_ref, base_ref?, focus?, personas?, content_path? }],
//         defaults?: { base_ref? }, reviewModel? }
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch {
    input = {}
  }
}
input = input || {}

const targets = Array.isArray(input.targets) ? input.targets : []
if (!targets.length) {
  log('penumbra-review-sweep: need args.targets = [{ target_ref, base_ref?, focus?, personas?, content_path? }].')
  return { ok: false, error: 'no_targets' }
}
const defaults = input.defaults || {}
// The proxy only brokers workflow_run; the personas run on their own routed agents
// inside the daemon, so the proxy itself can be cheap.
const reviewModel = input.reviewModel || 'haiku'

const REVIEW_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'target_ref'],
  properties: {
    ok: { type: 'boolean' },
    target_ref: { type: 'string' },
    base_ref: { type: 'string' },
    outcome: { type: 'string', description: 'success | success_partial | failed | error' },
    workflow_run_id: { type: 'string' },
    synthesis_path: { type: 'string', description: 'path to synthesis.md if produced' },
    summary: { type: 'string', description: 'short summary of the synthesized findings' },
    error_summary: { type: 'string' },
  },
}

function buildPrompt(target) {
  const reviewArgs = {
    target_ref: target.target_ref || 'HEAD',
    base_ref: target.base_ref || defaults.base_ref || 'main',
  }
  if (target.focus) reviewArgs.focus = target.focus
  if (target.content_path) reviewArgs.content_path = target.content_path
  if (Array.isArray(target.personas) && target.personas.length) reviewArgs.personas = target.personas
  return [
    "You are a review-sweep proxy. Run penumbra's native adversarial-review workflow against ONE target and report the outcome. Do NOT review the code yourself — the workflow's personas do that.",
    '',
    'Start the run with mcp__penumbra__workflow_run:',
    '```json',
    JSON.stringify({ name: 'adversarial-review', args: reviewArgs, wait: true }, null, 2),
    '```',
    'With wait=true the call returns the full result body when the run finishes. From it, extract: outcome (success / success_partial / failed), workflow_run_id, the synthesis.md path if present, and a short summary of the synthesized findings.',
    'If the call instead returns a run id without a finished body (or wait times out), fall back to polling: mcp__penumbra__workflow_wait({ workflow_run_id, timeout_ms: 1800000 }) until terminal, then mcp__penumbra__workflow_status({ workflow_run_id }) for the outcome.',
    '',
    'Return StructuredOutput per schema. ok=true when the run reached success or success_partial; otherwise ok=false with error_summary.',
  ].join('\n')
}

phase('Review')
const results = await parallel(
  targets.map((target, i) => () =>
    agent(buildPrompt(target), {
      label: `review:${target.target_ref || 'HEAD'}#${i}`,
      phase: 'Review',
      schema: REVIEW_RESULT,
      ...(reviewModel && reviewModel !== 'inherit' ? { model: reviewModel } : {}),
    }),
  ),
)

const clean = results.filter(Boolean)
const ok = clean.filter((r) => r.ok)
log(`penumbra-review-sweep: ${ok.length}/${targets.length} targets reviewed ok.`)
return {
  ok: ok.length === targets.length && clean.length === targets.length,
  total: targets.length,
  reviewed_ok: ok.length,
  results: clean,
}
