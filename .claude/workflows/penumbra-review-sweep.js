export const meta = {
  name: 'penumbra-review-sweep',
  description: "Fan out penumbra's native adversarial-review across several targets (one workflow_run per diff / PR / path), in parallel, and collect each synthesis. Wraps the daemon workflow — keeping its persona routing, pass-rate gates, and agent_performance capture — rather than reimplementing it.",
  whenToUse: 'When you want the multi-persona adversarial review run against MULTIPLE targets at once (several PRs, or several diff ranges / files). Pass args.repo (absolute path, required — the sweep fails closed without it) and args.targets = [{ target_ref, base_ref?, focus?, personas?, content_path?, repo? }]. Each runs the real penumbra adversarial-review.',
  phases: [{ title: 'Review', detail: 'one penumbra workflow_run(adversarial-review) per target, in parallel' }],
}

// args: { repo, targets: [{ target_ref, base_ref?, focus?, personas?, content_path?, repo? }],
//         defaults?: { base_ref?, reviewTimeoutMs? }, reviewModel?, reviewTimeoutMs? }
// task-spec-validation:begin
function validateSpec(spec) {
  const workflowName = spec.workflowName || 'workflow'
  const allowedList = (keys) => keys.join(', ')

  function validateObject(value, location, allowedKeys, requiredKeys) {
    const allowed = new Set(allowedKeys || [])
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${workflowName}: ${location} must be an object; allowed keys: ${allowedList(allowedKeys || [])}`)
    }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new Error(`${workflowName}: unknown key "${key}" at ${location}; allowed keys: ${allowedList(allowedKeys || [])}`)
      }
    }
    for (const key of requiredKeys || []) {
      if (!(key in value) || value[key] === undefined || value[key] === null || value[key] === '') {
        throw new Error(`${workflowName}: missing required key "${key}" at ${location}; allowed keys: ${allowedList(allowedKeys || [])}`)
      }
    }
  }

  if (spec.validateTopLevel !== false) {
    validateObject(spec.input || {}, 'args', spec.topLevelAllowedKeys || [], spec.requiredTopLevelKeys || [])
  }

  if (spec.defaults !== undefined) {
    validateObject(spec.defaults, 'defaults', spec.defaultsAllowedKeys || [], [])
  }

  if (spec.tasks !== undefined) {
    if (!Array.isArray(spec.tasks) || (spec.requireTasks && spec.tasks.length === 0)) {
      throw new Error(`${workflowName}: tasks must be a non-empty array; allowed keys: ${allowedList(spec.taskAllowedKeys || [])}`)
    }
    for (let i = 0; i < spec.tasks.length; i++) {
      const location = spec.taskLocationPrefix === 'task' && spec.tasks.length === 1 ? 'task' : `${spec.taskLocationPrefix || 'tasks'}[${i}]`
      validateObject(spec.tasks[i], location, spec.taskAllowedKeys || [], spec.taskRequiredKeys || [])
    }
  }
}
// task-spec-validation:end

let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch {
    input = {}
  }
}
input = input || {}

validateSpec({
  workflowName: 'penumbra-review-sweep',
  input,
  topLevelAllowedKeys: ['targets', 'defaults', 'repo', 'reviewModel', 'reviewTimeoutMs'],
  defaults: input.defaults,
  defaultsAllowedKeys: ['base_ref', 'reviewTimeoutMs'],
  tasks: input.targets,
  taskAllowedKeys: ['target_ref', 'base_ref', 'focus', 'content_path', 'personas', 'repo'],
  taskLocationPrefix: 'targets',
})

const targets = Array.isArray(input.targets) ? input.targets : []
if (!targets.length) {
  log('penumbra-review-sweep: need args.targets = [{ target_ref, base_ref?, focus?, personas?, content_path?, repo? }].')
  return { ok: false, error: 'no_targets' }
}
// Workflow script sandboxes have no process object, so repo scope must come
// from the parsed args.repo value rather than process.env or process.cwd().
// There is deliberately no default: a missing repo is what lets the daemon
// resolve cwd to its own tree and return a clean-looking void review.
const REPO = String((input && input.repo) || '').trim()
if (!REPO.startsWith('/')) {
  log('penumbra-review-sweep: args.repo must be a non-empty ABSOLUTE path — it is passed as workflow_run cwd; without it the daemon resolves cwd to ITS OWN repo and every persona reviews the wrong tree, returning a clean-looking VOID report.')
  return { ok: false, error: 'no_repo_scope' }
}
for (const t of targets) {
  if (t.repo !== undefined && !(typeof t.repo === 'string' && t.repo.trim().startsWith('/'))) {
    throw new Error(`penumbra-review-sweep: target repo must be an ABSOLUTE path when present; got ${JSON.stringify(t.repo)}`)
  }
}
const defaults = input.defaults || {}
// The proxy only brokers workflow_run; the personas run on their own routed agents
// inside the daemon, so the proxy itself can be cheap.
const reviewModel = input.reviewModel || 'haiku'
// adversarial-review can run 30+ min for full multi-persona reviews; size the poll
// ceiling off a configurable budget (default 40 min) instead of a fixed count.
const reviewTimeoutMs = input.reviewTimeoutMs || defaults.reviewTimeoutMs || 2400000
const maxPolls = Math.ceil(reviewTimeoutMs / 90000)

const REVIEW_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'target_ref', 'index', 'diff_truncated', 'diff_dropped_files'],
  properties: {
    ok: { type: 'boolean' },
    target_ref: { type: 'string', description: 'the target_ref echoed verbatim, binding this result to its sweep target' },
    index: { type: 'integer', description: 'zero-based position of this target in the sweep, echoed verbatim' },
    base_ref: { type: 'string' },
    outcome: { type: 'string', description: 'success | success_partial | failed | error' },
    workflow_run_id: { type: 'string' },
    synthesis_path: { type: 'string', description: 'path to synthesis.md if produced' },
    summary: { type: 'string', description: 'short summary of the synthesized findings' },
    resolution_warning: { type: 'string', description: 'verbatim resolution_warning from the workflow_run response, when present' },
    review_cwd: { type: 'string', description: 'absolute cwd passed to workflow_run and workflow_wait' },
    diff_truncated: { type: 'boolean', description: 'REQUIRED. verbatim diff_truncated from the terminal runResult — the review saw only part of the diff. If the runResult omits it, set false explicitly; never omit this field.' },
    diff_dropped_files: { type: 'array', items: { type: 'string' }, description: 'REQUIRED. verbatim diff_dropped_files from the terminal runResult — file sections the cap dropped. If the runResult omits it, set [] explicitly; never omit this field.' },
    diff_dropped_more: { type: 'boolean', description: 'verbatim diff_dropped_more from the terminal runResult — the dropped-file list itself was capped at 20 names' },
    diff_cut_file: { type: 'string', description: 'verbatim diff_cut_file from the terminal runResult — a single oversized file section cut at a line boundary' },
    error_summary: { type: 'string' },
  },
}

function buildPrompt(target, i) {
  const targetId = target.target_ref || `target-${i}`
  const reviewArgs = {
    target_ref: target.target_ref || 'HEAD',
    base_ref: target.base_ref || defaults.base_ref || 'main',
  }
  if (target.focus) reviewArgs.focus = target.focus
  if (target.content_path) reviewArgs.content_path = target.content_path
  if (Array.isArray(target.personas) && target.personas.length) reviewArgs.personas = target.personas
  const targetRepo = typeof target.repo === 'string' && target.repo.trim() ? target.repo.trim() : REPO
  return [
    "You are a review-sweep proxy. Run penumbra's native adversarial-review workflow against ONE target and report the outcome. Do NOT review the code yourself — the workflow's personas do that.",
    '',
    'Start the run NON-BLOCKING. Do NOT use wait=true: adversarial-review takes ~7-12 min, and a single blocking call exceeds the workflow runtime watchdog (~180s of no progress) — it gets killed and retried, which spawns DUPLICATE reviews. Call workflow_run exactly ONCE with wait=false:',
    '```json',
    JSON.stringify({ name: 'adversarial-review', cwd: targetRepo, args: reviewArgs, wait: false }, null, 2),
    '```',
    `Capture workflow_run_id from the immediate response (it returns within seconds; if it has a workflow_run_id but no outcome, it is a pending run). If the response carries a resolution_warning field, copy it VERBATIM into the resolution_warning output field — a value of "workflow_cwd_inferred_from_mcp_cwd" means the run resolved to the daemon's own repo and every persona reviewed the wrong tree, so report ok=false with error_summary naming the warning. Set review_cwd to the cwd you passed (${targetRepo}).`,
    `Then POLL with SHORT waits so you never stall: repeatedly call mcp__penumbra__workflow_wait({ workflow_run_id, timeout_ms: 90000, cwd: ${JSON.stringify(targetRepo)} }) — each returns within ~90s (under the watchdog) reporting terminal-or-still-running — until it reports a terminal state, for at most ${maxPolls} iterations (~${Math.round(reviewTimeoutMs / 60000)} min total). NEVER issue one long wait, and NEVER call workflow_run again.`,
    'When terminal, read outcome, synthesis.md artifact path, and diff_truncated / diff_dropped_files from the TERMINAL mcp__penumbra__workflow_wait response you already polled (workflow_status is progress-only run state and does not include the result payload). Both coverage fields are REQUIRED in your report — copy them verbatim, and when the runResult omits them report diff_truncated=false and diff_dropped_files=[].',
    '',
    `Return StructuredOutput per schema. ok=true only when the run reached success or success_partial AND carried no resolution_warning AND diff_truncated is not true — a capped diff is partial coverage, which is NOT a clean review; when diff_truncated is true report ok=false with error_summary "partial_diff_coverage". Echo the target_ref "${targetId}" and index ${i} VERBATIM into target_ref and index.`,
  ].join('\n')
}

phase('Review')
const results = await parallel(
  targets.map((target, i) => () =>
    agent(buildPrompt(target, i), {
      label: `review:${target.target_ref || 'HEAD'}#${i}`,
      phase: 'Review',
      schema: REVIEW_RESULT,
      ...(reviewModel && reviewModel !== 'inherit' ? { model: reviewModel } : {}),
    }),
  ),
)

// Index-preserving: results[i] answers targets[i] even when the proxy call
// dropped, so positional consumers keep their target pairing.
// A diff_truncated review is partial coverage: force ok=false regardless of
// what the proxy reported — zero HIGH on a partial diff is not a clean pass.
const clean = results.map((r, i) => {
  const targetRef = targets[i].target_ref || `target-${i}`
  if (!r) {
    return { ok: false, target_ref: targetRef, index: i, error_summary: 'agent_dropped' }
  }
  return r.diff_truncated === true && r.ok === true
    ? { ...r, ok: false, error_summary: 'partial_diff_coverage', target_ref: targetRef, index: i }
    : { ...r, target_ref: targetRef, index: i }
})
const ok = clean.filter((r) => r.ok)
const dropped = clean.filter((r) => r.error_summary === 'agent_dropped')
log(
  `penumbra-review-sweep: ${ok.length}/${targets.length} targets reviewed ok.` +
    (dropped.length
      ? ` ${dropped.length} dropped (agent skipped/errored): ${dropped.map((d) => d.target_ref).join(', ')}`
      : ''),
)
return {
  ok: ok.length === targets.length,
  total: targets.length,
  reviewed_ok: ok.length,
  dropped,
  results: clean,
}
