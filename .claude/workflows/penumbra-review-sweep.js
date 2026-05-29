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
    'Start the run NON-BLOCKING. Do NOT use wait=true: adversarial-review takes ~7-12 min, and a single blocking call exceeds the workflow runtime watchdog (~180s of no progress) — it gets killed and retried, which spawns DUPLICATE reviews. Call workflow_run exactly ONCE with wait=false:',
    '```json',
    JSON.stringify({ name: 'adversarial-review', args: reviewArgs, wait: false }, null, 2),
    '```',
    'Capture workflow_run_id from the immediate response (it returns within seconds; if it has a workflow_run_id but no outcome, it is a pending run).',
    'Then POLL with SHORT waits so you never stall: repeatedly call mcp__penumbra__workflow_wait({ workflow_run_id, timeout_ms: 90000 }) — each returns within ~90s (under the watchdog) reporting terminal-or-still-running — until it reports a terminal state, for at most ~12 iterations. NEVER issue one long wait, and NEVER call workflow_run again.',
    'When terminal, call mcp__penumbra__workflow_status({ workflow_run_id }) to read the outcome and the synthesis.md artifact path; summarize the synthesized findings.',
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
