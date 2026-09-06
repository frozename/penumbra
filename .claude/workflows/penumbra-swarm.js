export const meta = {
  name: 'penumbra-swarm',
  description: 'Decompose a high-level goal into N independent penumbra task specs with a planner agent, then fan them out to the fleet via chain_start and collect every result',
  whenToUse: 'When you have a goal but not a task list yet. A planner breaks it into independent, parallelizable penumbra dispatches; penumbra-fanout runs them on the fleet; results are collected. Tasks MUST be independent (isolated worktrees, run in parallel). Landing the handoff branch_name branches stays with the orchestrator. Pass the goal as args (string) or args.goal.',
  phases: [
    { title: 'Plan', detail: 'one planner agent decomposes the goal into independent task specs' },
    { title: 'Dispatch', detail: 'delegate to penumbra-fanout: one chain_start per task; wait; collect' },
  ],
}

// args:
//   string                       -> the goal
//   { goal, maxTasks?, defaults?, agentType? }
//     defaults/agentType are forwarded to penumbra-fanout (see that script's header).

// args may arrive as a plain goal string, an object, or a JSON string (the Workflow
// `args` field is untyped, so a JSON object passed in the tool call can reach the
// script stringified). Parse only when the string clearly looks like JSON.
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
  const s = input.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      input = JSON.parse(s)
    } catch {
      /* keep as goal string */
    }
  }
}

const opts = typeof input === 'object' && input ? input : {}
if (typeof input === 'object' && input) {
  validateSpec({
    workflowName: 'penumbra-swarm',
    input: opts,
    topLevelAllowedKeys: ['goal', 'maxTasks', 'defaults', 'agentType', 'plannerModel', 'dispatcherModel', 'project_id', 'caller_cwd', 'repo'],
    defaults: opts.defaults,
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
      'response_mode',
      'project_id',
      'caller_cwd',
      'isolated_install',
    ],
  })
}

const goal = typeof input === 'string' ? input : input && input.goal
if (!goal || !String(goal).trim()) {
  log('penumbra-swarm: no goal. Pass the goal as args (string) or args.goal.')
  return { ok: false, error: 'no_goal' }
}

const maxTasks = Math.max(0, opts.maxTasks ?? 8)
const defaults = opts.defaults || {}
const fanoutDefaults = { ...defaults }
if (opts.project_id !== undefined) fanoutDefaults.project_id = opts.project_id
if (opts.caller_cwd !== undefined) fanoutDefaults.caller_cwd = opts.caller_cwd
const agentType = opts.agentType
// Planner does real reasoning → default to the session model (override via args.plannerModel).
// Dispatch proxies are pure glue → cheap by default, forwarded to penumbra-fanout.
const plannerModel = opts.plannerModel
const dispatcherModel = opts.dispatcherModel || 'sonnet'

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    summary: { type: 'string', description: 'one-line read of the decomposition' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task_class', 'task_type', 'message'],
        properties: {
          label: { type: 'string' },
          task_name: { type: 'string', description: 'short human-readable branch slug source' },
          branch_type: { type: 'string', description: 'optional branch type prefix such as feat, fix, docs, review, plan, chore, or task' },
          initial_agent: { type: 'string', description: 'role "executor" (default — the daemon router picks the seat) or a concrete fleet agent id as a deliberate pin (justify in rationale)' },
          task_class: { type: 'string', enum: ['BOUNDARY', 'STANDARD', 'TRIVIAL'] },
          task_type: { type: 'string', description: 'implement_small | implement_substantial | review_adversarial | docs_mechanical | debug_diagnose | plan_refine | smoke_test | health_check | unknown' },
          message: { type: 'string', description: 'self-contained instruction for the worker; no dependency on sibling tasks' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const plannerPrompt = [
  'You are a dispatch planner for the penumbra agent fleet. Decompose the GOAL below into a set of INDEPENDENT tasks that can run fully in parallel.',
  '',
  'Hard constraints:',
  `- At most ${maxTasks} tasks. Fewer is better — only split where parallelism genuinely helps.`,
  '- Each task runs in its OWN isolated git worktree branched from the default branch. Tasks CANNOT see each other\'s changes or any uncommitted work. Do NOT create tasks that depend on a sibling task\'s output, or that edit the same files. If the work is inherently sequential or shares files, return a single task.',
  '- Each message must be fully self-contained: state the file paths, the exact change, and the acceptance check. No references to "the other task".',
  '- Classify each task_class: BOUNDARY (architectural / cross-cutting / risky), STANDARD (normal feature/fix), TRIVIAL (mechanical, low-risk).',
  '- Pick a task_type from the enum. Set initial_agent to the role "executor" (the default — the daemon model task router picks the seat). Pin a concrete agent id ONLY when the task needs a specific capability; put the pin reason in rationale. chain_list_agents / agent_recommend are forensic checks, not a pre-pinning step.',
  '',
  'GOAL:',
  String(goal),
  '',
  'Return ONLY the StructuredOutput (summary + tasks). Do NOT dispatch anything yourself — planning only.',
].join('\n')

phase('Plan')
const plan = await agent(plannerPrompt, {
  label: 'plan',
  phase: 'Plan',
  schema: PLAN_SCHEMA,
  ...(plannerModel && plannerModel !== 'inherit' ? { model: plannerModel } : {}),
})

const tasks = ((plan && Array.isArray(plan.tasks) && plan.tasks) || []).slice(0, maxTasks)
if (!tasks.length) {
  log('penumbra-swarm: planner produced no tasks.')
  return { ok: false, error: 'empty_plan', goal, plan }
}
if (plan && Array.isArray(plan.tasks) && plan.tasks.length > maxTasks) {
  log(
    `penumbra-swarm: planner returned ${plan.tasks.length} tasks; truncated to maxTasks=${maxTasks} (dropped ${plan.tasks.length - maxTasks}).`,
  )
}
validateSpec({
  workflowName: 'penumbra-swarm',
  validateTopLevel: false,
  tasks,
  taskLocationPrefix: 'plan.tasks',
  taskAllowedKeys: [
    'label',
    'task_name',
    'branch_type',
    'initial_agent',
    'task_class',
    'task_type',
    'message',
    'rationale',
  ],
  taskRequiredKeys: ['task_class', 'task_type', 'message'],
})
log(`penumbra-swarm: planner produced ${tasks.length} task(s)${plan.summary ? ' — ' + plan.summary : ''}`)

phase('Dispatch')
// Reuse the fan-out primitive rather than re-implementing the dispatch proxy.
const dispatchTasks = tasks.map((t) => {
  const { rationale, ...task } = t
  return task
})
const fan = await workflow(
  'penumbra-fanout',
  { tasks: dispatchTasks, defaults: fanoutDefaults, dispatcherModel, ...(opts.repo !== undefined ? { repo: opts.repo } : {}), ...(agentType ? { agentType } : {}) },
)

return {
  ok: !!(fan && fan.ok),
  goal,
  plan,
  fanout: fan,
  branches: (fan && fan.branches) || [],
}
