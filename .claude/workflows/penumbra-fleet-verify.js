export const meta = {
  name: 'penumbra-fleet-verify',
  description:
    'Generic fleet fan-out: dispatch N arbitrary tasks to the penumbra fleet in PARALLEL, verify each branch against a generic schema, and return structured evidence per task. Lands NOTHING — maestro reviews the verdicts and lands each branch manually. Fabrication-proof: every handoff_id / SHA / count comes back as schema-validated data.',
  whenToUse:
    'Running several independent fleet implementation tasks at once where you want parallel dispatch + structured verification but explicit manual landing (e.g. real daemon/MCP changes that each warrant a review before touching main).',
  phases: [
    { title: 'DispatchVerify', detail: 'parallel: chain_start + schema-verify each task' },
  ],
}

// args (JSON string or object): { tasks: [{ name, dispatchPrompt, agent?, taskClass?, verifyChecklist? }] }
//   name            - short label (reporting only)
//   dispatchPrompt  - verbatim chain_start message (the task contract; MUST tell the
//                     agent to commit explicitly with a neutral message and run its
//                     own typecheck/tests)
//   agent           - fleet agent (default executor)
//   taskClass       - BOUNDARY | STANDARD | TRIVIAL (default STANDARD)
//   verifyChecklist - extra free-text checks the verifier should measure/report
//   branchBase      - optional git ref to base the worktree on (e.g. an unlanded
//                     handoff branch_name for a fix-round building on prior work);
//                     defaults to main. Verify uses merge-base, so the squash-land
//                     of the resulting branch carries the full base+fix footprint.
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

let a = args
if (typeof a === 'string') {
  try {
    a = JSON.parse(a)
  } catch {
    throw new Error('args was a string but not valid JSON: ' + a)
  }
}

validateSpec({
  workflowName: 'penumbra-fleet-verify',
  input: a || {},
  topLevelAllowedKeys: ['tasks', 'repo'],
  requiredTopLevelKeys: ['tasks'],
  tasks: a && a.tasks,
  requireTasks: true,
  taskAllowedKeys: [
    'name',
    'dispatchPrompt',
    'agent',
    'taskClass',
    'verifyChecklist',
    'branchBase',
    'task_name',
    'label',
    'title',
    'branch_type',
  ],
  taskRequiredKeys: ['name', 'dispatchPrompt'],
})

const tasks = (a && a.tasks) || []
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('args.tasks must be a non-empty array of { name, dispatchPrompt }')
}
for (const t of tasks) {
  if (!t || !t.name || !t.dispatchPrompt) {
    throw new Error('each task needs { name, dispatchPrompt }; got: ' + JSON.stringify(t))
  }
}

// Workflow script sandboxes have no process object, so repo scope must come
// from the parsed args.repo value rather than process.env or process.cwd().
const REPO = typeof a.repo === 'string' ? a.repo.trim() : ''
if (!REPO || !REPO.startsWith('/')) {
  throw new Error(
    'penumbra-fleet-verify: args.repo must be a non-empty ABSOLUTE path - it is passed as chain_start caller_cwd so the MCP layer can resolve project scope. The daemon rejects scope-less dispatches with HTTP 400 project_id_required when PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID is set.',
  )
}

const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'handoff_id', 'status', 'branch', 'branch_tip', 'commit_count'],
  properties: {
    name: { type: 'string' },
    handoff_id: { type: 'string', description: 'verbatim from chain_start result' },
    conversation_id: { type: 'string' },
    status: { type: 'string', description: 'terminal status from chain_status' },
    reliability_action: { type: 'string' },
    branch: { type: 'string', description: 'handoff branch_name, or "MISSING"' },
    branch_tip: { type: 'string' },
    commit_count: { type: 'integer' },
    worktree_path: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'typecheck_exit', 'tests_pass', 'tests_fail', 'files_changed', 'attribution_lines', 'verdict'],
  properties: {
    name: { type: 'string' },
    typecheck_exit: { type: 'integer', description: 'exit code of the repo typecheck in the worktree (-1 if not run)' },
    tests_pass: { type: 'integer' },
    tests_fail: { type: 'integer' },
    files_changed: { type: 'integer', description: 'git diff --name-only main..branch | wc -l' },
    changed_files: { type: 'string', description: 'newline list of changed paths' },
    attribution_lines: { type: 'integer', description: 'AI/assistant/co-authored lines in the commit message(s)' },
    checklist_result: { type: 'string', description: 'free-text findings against the task-specific verifyChecklist' },
    verdict: { type: 'string', enum: ['pass', 'fail'], description: 'pass iff typecheck_exit==0 AND tests_fail==0 AND attribution_lines==0 AND the checklist is satisfied' },
    notes: { type: 'string' },
  },
}

phase('DispatchVerify')

const results = await pipeline(
  tasks,
  // Stage 1: dispatch + wait + collect real branch facts.
  (t) =>
    agent(
      [
        `Dispatch ONE task to the penumbra fleet; report ONLY verbatim tool-output values. Never invent an id or SHA.`,
        `STEP 1: mcp__penumbra__chain_start with initial_agent="${t.agent || 'executor'}", task_class="${t.taskClass || 'STANDARD'}", task_type="implement_small", task_name="${t.task_name || t.label || t.name || t.title}", caller_cwd="${REPO}", ${t.branchBase ? `branch_base="${t.branchBase}", ` : ''}${t.branch_type ? `branch_type="${t.branch_type}", ` : ''}message = the EXACT contract below.`,
        `--- CONTRACT (verbatim) ---`,
        t.dispatchPrompt,
        `--- END CONTRACT ---`,
        `STEP 2: copy handoff_id + conversation_id + provisional branch_name verbatim from the chain_start result; the chain_start value is provisional because a collision suffix may be applied by the worker.`,
        `STEP 3: poll mcp__penumbra__chain_status until terminal; chain_wait <=150s per call, one wait per step. Take the FINAL branch_name from the terminal chain_wait or chain_status result; fallback to the chain_start value only if the terminal result lacks it.`,
        `STEP 4: in ${REPO}: git rev-parse --verify --quiet <branch_name> (branch_tip, "MISSING" if absent); git rev-list --count main..<branch_name> (commit_count); git worktree list | grep <handoff_id> (worktree_path).`,
        `Set name="${t.name}". Return the structured object; every value from a tool result you saw this turn.`,
      ].join('\n'),
      // dispatch driver is mechanical glue (chain_start + poll + git facts) — runs on a
      // cheap tier, not the inherited session model. Sonnet (not Haiku) to stay reliable
      // on the multi-step poll lifecycle + verbatim id/SHA copying.
      { label: `dispatch:${t.name}`, phase: 'DispatchVerify', schema: DISPATCH_SCHEMA, model: 'sonnet' },
    ).then((dispatch) => ({ task: t, dispatch })),
  // Stage 2: verify (skip if no branch).
  (prev, t) => {
    const d = prev && prev.dispatch
    if (!d || d.branch === 'MISSING' || d.commit_count < 1) {
      return { name: t.name, dispatch: d, verify: null, skipped: 'no-branch' }
    }
    const wt = d.worktree_path || `${REPO}-worktrees/${d.handoff_id}`
    return agent(
      [
        `Independently VERIFY fleet task "${t.name}" on branch ${d.branch} (tip ${d.branch_tip}). DO NOT land/push/edit/delete. Worktree: ${wt}.`,
        `Measure exact values (single-token outputs for counts):`,
        `1. in worktree: run the repo typecheck for the touched package(s) (e.g. bunx tsc --build packages/<pkg>/tsconfig.json) -> typecheck_exit. If you cannot determine the package, set -1 and explain in notes.`,
        `2. in worktree: run the relevant test slice (bun test <paths>) -> tests_pass, tests_fail.`,
        `3. from ${REPO}: compute the branch's OWN footprint using the merge-base: run "git diff --name-only $(git merge-base main ${d.branch})..${d.branch}" -> files_changed (count) + changed_files (the list). MUST use the merge-base form, NOT "main..${d.branch}" — commits that landed on main in parallel would otherwise show as bogus changed/deleted files and trigger a false scope-bleed fail.`,
        `4. git log main..${d.branch} --format=%B | count (co-authored|claude|codex|gpt|assistant|generated with|robot) -> attribution_lines.`,
        `5. checklist_result: measure these task-specific checks and report findings: ${t.verifyChecklist || '(none beyond the standard gates)'}`,
        `Set name="${t.name}" and verdict per schema. Report only measured values.`,
      ].join('\n'),
      // verifier is the adversarial QUALITY GATE (runs tests, classifies failures,
      // checks the contract) — keep it capable: Sonnet, never Haiku. Do NOT economize
      // here or it rubber-stamps regressions.
      { label: `verify:${t.name}`, phase: 'DispatchVerify', schema: VERIFY_SCHEMA, model: 'sonnet' },
    ).then((verify) => ({ name: t.name, dispatch: d, verify }))
  },
)

const real = results.filter(Boolean)
const landable = real.filter((r) => r.verify && r.verify.verdict === 'pass')

return {
  ranNothingToMain: true,
  tasks: tasks.length,
  results: real,
  landable: landable.map((r) => ({
    name: r.name,
    handoff_id: r.dispatch.handoff_id,
    branch: r.dispatch.branch,
    branch_tip: r.dispatch.branch_tip,
    land_command: `dispatch_land(handoff_id="${r.dispatch.handoff_id}", mode="squash", commit_message="<neutral subject>")`,
  })),
  next: 'maestro reviews verdicts, then lands each landable branch ONE AT A TIME (land -> verify HEAD moved + content in main -> push -> teardown). Nothing landed by the workflow.',
}
