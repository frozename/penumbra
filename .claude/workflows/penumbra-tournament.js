export const meta = {
  name: 'penumbra-tournament',
  description: 'Best-of-N: dispatch the SAME task to K different penumbra fleet agents in parallel, then a judge agent inspects each candidate worktree (diff + log) and ranks them, picking a winner. Maestro lands the winner; the rest can be GC\'d.',
  whenToUse: 'When a task is high-value or hard and fleet diversity pays off — run several agents (codex / gemini / claude / local) on the SAME task and keep the best. Pass args.task + args.agents. Nothing is landed; the judge only inspects.',
  phases: [
    { title: 'Compete', detail: 'dispatch the same task to each agent on its own worktree branch' },
    { title: 'Judge', detail: 'one judge inspects every candidate worktree (diff + log) and ranks; picks the winner' },
  ],
}

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

// args: { task: { message, task_class?, task_type? }, agents: [agentId, ...],
//         defaults?, dispatcherModel?, judgeModel?, project_id?, caller_cwd?, repo? }
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch {
    throw new Error('penumbra-tournament: args was a string but not valid JSON: ' + String(args).slice(0, 200))
  }
}
input = input || {}

const task = input.task
const agents = Array.isArray(input.agents) ? input.agents : []
if (!task || !task.message || !agents.length) {
  log('penumbra-tournament: need args.task = { message, task_class?, task_type? } and args.agents = [agentId, ...].')
  return { ok: false, error: 'missing_task_or_agents' }
}
const defaults = input.defaults || {}
const fanoutDefaults = { ...defaults }
if (input.project_id !== undefined) fanoutDefaults.project_id = input.project_id
if (input.caller_cwd !== undefined) fanoutDefaults.caller_cwd = input.caller_cwd

if (typeof input.repo === 'string' && input.repo.trim() && !input.repo.trim().startsWith('/')) {
  throw new Error('penumbra-tournament: args.repo must be an absolute path')
}

validateSpec({
  workflowName: 'penumbra-tournament',
  input,
  topLevelAllowedKeys: ['task', 'agents', 'defaults', 'dispatcherModel', 'judgeModel', 'project_id', 'caller_cwd', 'repo'],
  requiredTopLevelKeys: ['task', 'agents'],
  defaults: fanoutDefaults,
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
  tasks: [task],
  requireTasks: true,
  taskLocationPrefix: 'task',
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
    'response_mode',
    'project_id',
    'caller_cwd',
    'isolated_install',
  ],
  taskRequiredKeys: ['message'],
})

const dispatcherModel = input.dispatcherModel || 'sonnet'
const judgeModel = input.judgeModel // default: session model (judging is real reasoning)

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['winner_branch', 'ranking'],
  properties: {
    winner_branch: { type: 'string' },
    winner_agent: { type: 'string' },
    rationale: { type: 'string' },
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['branch', 'score'],
        properties: {
          branch: { type: 'string' },
          agent: { type: 'string' },
          score: { type: 'number', description: '0-10' },
          notes: { type: 'string' },
        },
      },
    },
  },
}

phase('Compete')
// tournament agents are deliberate pins by design — diversity is the objective, not router score
if (task.use_worktree === false) {
  log('penumbra-tournament: overriding task.use_worktree=false with true because each candidate needs its own worktree for judging')
}
const tasks = agents.map((ag) => ({
  ...task,
  label: `compete:${ag}`,
  task_name: task.task_name || task.label || task.name || task.title || defaults.task_name || 'tournament-candidate',
  initial_agent: ag,
  use_worktree: true,
}))

validateSpec({
  workflowName: 'penumbra-tournament',
  validateTopLevel: false,
  defaults: fanoutDefaults,
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
  tasks,
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
    'response_mode',
    'project_id',
    'caller_cwd',
    'isolated_install',
  ],
  taskRequiredKeys: ['message'],
})

const fan = await workflow(
  'penumbra-fanout',
  { tasks, defaults: fanoutDefaults, dispatcherModel, ...(typeof input.repo === 'string' ? { repo: input.repo } : {}) },
)
const candidates = ((fan && fan.results) || []).filter((r) => r && r.ok && r.branch && r.handoff_id)
if (!candidates.length) {
  log('penumbra-tournament: no successful candidates to judge.')
  return { ok: false, error: 'no_successful_candidates', fanout: fan }
}
log(`penumbra-tournament: ${candidates.length}/${agents.length} candidates produced a branch; judging.`)

phase('Judge')
const roster = candidates
  .map((c) => `- branch ${c.branch} | agent ${c.initial_agent || 'unknown'} | handoff_id ${c.handoff_id}`)
  .join('\n')
const judgePrompt = [
  'You are the judge in a best-of-N code tournament. Several agents independently attempted the SAME task, each on its own worktree branch. Pick the best implementation.',
  '',
  'Original task:',
  task.message,
  '',
  'Candidates:',
  roster,
  '',
  'For EACH candidate, call mcp__penumbra__worktree_inspect({ handoff_id }) to get its diff and branch log. Judge on: correctness against the task, scope discipline (no unrelated edits), simplicity, and overall quality. Do NOT modify or land anything — inspection only.',
  '',
  'Return StructuredOutput: a ranking (score 0-10 each, with notes) plus winner_branch + winner_agent + a short rationale.',
].join('\n')
const verdict = await agent(judgePrompt, {
  label: 'judge',
  phase: 'Judge',
  schema: VERDICT,
  ...(judgeModel && judgeModel !== 'inherit' ? { model: judgeModel } : {}),
})

return {
  ok: !!(verdict && verdict.winner_branch),
  task,
  candidates: candidates.map((c) => ({ agent: c.initial_agent, branch: c.branch, handoff_id: c.handoff_id })),
  verdict,
  winner: verdict && verdict.winner_branch,
  // All candidate branches exist; maestro lands the winner and GCs the rest.
  branches: candidates.map((c) => c.branch),
  loser_branches: candidates
    .map((c) => c.branch)
    .filter((b) => b !== (verdict && verdict.winner_branch)),
}
