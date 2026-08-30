export const meta = {
  name: 'penumbra-fanout',
  description: 'Fan out N tasks to the penumbra fleet via chain_start (one dispatch per task), wait for each to terminate, and collect every worker result',
  whenToUse: 'When you have several independent tasks to run on the penumbra fleet at once and want the fan-out, waiting, and result collection codified as a rerunnable script. Pass args.tasks. Landing the resulting handoff branch_name branches stays with the orchestrator.',
  phases: [
    { title: 'Dispatch', detail: 'one penumbra chain_start per task; wait for terminal; collect final response' },
  ],
}

// args shape:
// {
//   defaults?: { initial_agent?, task_class?, task_type?, trust_mode?, use_worktree?, max_hops?, timeout_ms? },
//   tasks: [ { label?, name?, title?, task_name?, branch_type?, initial_agent?, task_class?, task_type?, trust_mode?, use_worktree?, max_hops?, timeout_ms?, message } ],
//   agentType?: 'penumbra-dispatcher'   // set once the subagent is registered (needs a session restart to load)
// }

// args may arrive as an object OR as a JSON string (the Workflow `args` field is
// untyped, so a JSON object passed in the tool call can reach the script stringified).
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

validateSpec({
  workflowName: 'penumbra-fanout',
  input: input || {},
  topLevelAllowedKeys: ['tasks', 'defaults', 'agentType', 'dispatcherModel'],
  requiredTopLevelKeys: ['tasks'],
  defaults: input && input.defaults,
  defaultsAllowedKeys: [
    'initial_agent',
    'task_class',
    'task_type',
    'trust_mode',
    'use_worktree',
    'max_hops',
    'timeout_ms',
    'task_name',
    'branch_type',
    'branch_base',
  ],
  tasks: input && input.tasks,
  requireTasks: true,
  taskAllowedKeys: [
    'label',
    'name',
    'title',
    'task_name',
    'branch_type',
    'initial_agent',
    'task_class',
    'task_type',
    'trust_mode',
    'use_worktree',
    'max_hops',
    'timeout_ms',
    'message',
    'branch_base',
  ],
  taskRequiredKeys: ['message'],
})

const tasks = input && input.tasks
if (!Array.isArray(tasks) || !tasks.length) {
  log('penumbra-fanout: no tasks. Pass args.tasks = [{ initial_agent, task_class, task_type, message, ... }] (must be an array).')
  return { ok: false, error: 'no_tasks', total: 0, completed: 0, failed: 0, results: [] }
}

const defaults = (input && input.defaults) || {}
const agentType = input && input.agentType // optional override; omit to use the default self-contained workflow subagent
// The proxy is pure glue (dispatch + poll + return) — the real work runs on the
// penumbra fleet agent, not here. Pin it to a cheap model so it doesn't inherit
// the (expensive) session model. Override via args.dispatcherModel; 'inherit' to follow the session.
const dispatcherModel = (input && input.dispatcherModel) || 'sonnet'

// BOUNDARY work shouldn't flow through unattended auto-approve. Warn loudly per task.
for (const t of tasks) {
  const tc = t.task_class || defaults.task_class
  const tm = t.trust_mode || defaults.trust_mode || 'all'
  if (tc === 'BOUNDARY' && tm === 'all') {
    log(
      `WARNING: task "${t.label || t.initial_agent || '?'}" is BOUNDARY + trust_mode:all — unattended auto-approve of architectural work. Route BOUNDARY through maestro with review gates, or set trust_mode:'config'.`,
    )
  }
}

const DISPATCH_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'status'],
  properties: {
    ok: { type: 'boolean', description: 'true only when the chain reached a completed terminal state' },
    status: { type: 'string', description: 'completed | failed | timeout | error' },
    initial_agent: { type: 'string', description: 'the role or seat as dispatched (roles resolve daemon-side via the router)' },
    conversation_id: { type: 'string' },
    handoff_id: { type: 'string' },
    branch: { type: 'string', description: 'handoff branch_name if a worktree branch was created' },
    response: { type: 'string', description: 'final worker response text (may be truncated)' },
    error_summary: { type: 'string', description: 'short reason when ok=false' },
    latency_seconds: { type: 'number' },
  },
}

function buildSpec(t) {
  const spec = {
    initial_agent: t.initial_agent || defaults.initial_agent || 'executor',
    task_class: t.task_class || defaults.task_class || 'STANDARD',
    task_type: t.task_type || defaults.task_type || 'unknown',
    trust_mode: t.trust_mode || defaults.trust_mode || 'all',
    use_worktree: t.use_worktree ?? defaults.use_worktree ?? true,
    max_hops: t.max_hops || defaults.max_hops || 8,
    timeout_ms: t.timeout_ms || defaults.timeout_ms || 1800000,
    message: t.message,
  }
  const taskName = t.task_name || t.label || t.name || t.title || defaults.task_name
  if (taskName) spec.task_name = taskName
  const branchType = t.branch_type || defaults.branch_type
  if (branchType) spec.branch_type = branchType
  // Optional: base the worktree on a prior agent branch (enables iterative loops
  // like fix-until-green that build on the previous round's branch).
  const branchBase = t.branch_base || defaults.branch_base
  if (branchBase) spec.branch_base = branchBase
  return spec
}

function buildPrompt(t) {
  const spec = buildSpec(t)
  return [
    'You are a penumbra dispatch proxy. Broker exactly ONE penumbra chain dispatch and report its outcome.',
    'Do NOT implement the task yourself, edit files, or land branches — you only dispatch one chain and report the result.',
    'CRITICAL: pass the spec.message string INLINE as the mcp__penumbra__chain_start `message` argument. Do NOT stage it to a file, /tmp, a heredoc, or `cat >` — filesystem writes are NOT allowlisted in workflow agents, so they are permission-denied and stall the whole run. You need NO Bash at all; use only the mcp__penumbra__chain_* MCP tools.',
    '',
    'Dispatch spec:',
    '```dispatch',
    JSON.stringify(spec, null, 2),
    '```',
    '',
    'Protocol:',
    '1. Pass initial_agent verbatim to chain_start. A role name ("executor", "reviewer", "planner") is the DEFAULT: the daemon model task router resolves the seat (routing_resolution_reason=role_route). A concrete seat id is a deliberate pin — pass it verbatim, never substitute it. If initial_agent is the literal "AUTO" (legacy), use "executor". Do NOT call agent_recommend to pre-pick a seat; it is forensic only.',
    '2. Call mcp__penumbra__chain_start with initial_agent, message, task_class, task_type, trust_mode, use_worktree, max_hops, task_name, branch_type, and branch_base if present in the spec. Capture conversation_id, handoff_id, and provisional branch_name from the result; the chain_start value is provisional because a collision suffix may be applied by the worker.',
    '3. Poll with SHORT waits so you never stall: repeatedly call mcp__penumbra__chain_wait({ conversation_id, timeout_ms: 90000 }) — each returns within ~90s (under the workflow runtime no-progress watchdog), reporting terminal-or-still-running — until status is terminal (completed/failed), for at most ceil(spec.timeout_ms / 90000) iterations. Do NOT issue a single long blocking wait. Use mcp__penumbra__chain_status({ handoff_id }) for cheap liveness if needed. Take the FINAL branch_name from the terminal chain_wait or chain_status result; fallback to the chain_start value only if the terminal result lacks it.',
    '4. Call mcp__penumbra__chain_get_response({ conversation_id, which: "final" }) for the worker response.',
    '5. Return StructuredOutput per schema. ok=true only on a completed terminal state; otherwise ok=false with status and error_summary. Report branch as the FINAL branch_name if a worktree was created. Do not retry.',
  ].join('\n')
}

phase('Dispatch')

const results = await parallel(
  tasks.map((t, i) => () =>
    agent(buildPrompt(t), {
      label: t.label || `dispatch:${t.initial_agent || defaults.initial_agent || 'executor'}#${i}`,
      phase: 'Dispatch',
      schema: DISPATCH_RESULT,
      ...(dispatcherModel && dispatcherModel !== 'inherit' ? { model: dispatcherModel } : {}),
      ...(agentType ? { agentType } : {}),
    }),
  ),
)

const clean = results.filter(Boolean)
const completed = clean.filter((r) => r.ok)
const failed = clean.filter((r) => !r.ok)
const dropped = tasks.length - clean.length

log(
  `penumbra-fanout: ${completed.length}/${tasks.length} completed, ${failed.length} failed` +
    (dropped ? `, ${dropped} dropped (agent skipped/errored)` : ''),
)

return {
  ok: failed.length === 0 && dropped === 0 && clean.length === tasks.length,
  total: tasks.length,
  completed: completed.length,
  failed: failed.length,
  dropped,
  // Branches ready for the orchestrator to review + dispatch_land (this workflow never lands):
  branches: completed.map((r) => r.branch).filter(Boolean),
  results: clean,
}
