export const meta = {
  name: 'penumbra-tournament',
  description: 'Best-of-N: dispatch the SAME task to K different penumbra fleet agents in parallel, then a judge agent inspects each candidate worktree (diff + log) and ranks them, picking a winner. Maestro lands the winner; the rest can be GC\'d.',
  whenToUse: 'When a task is high-value or hard and fleet diversity pays off — run several agents (codex / gemini / claude / local) on the SAME task and keep the best. Pass args.task + args.agents. Nothing is landed; the judge only inspects.',
  phases: [
    { title: 'Compete', detail: 'dispatch the same task to each agent on its own worktree branch' },
    { title: 'Judge', detail: 'one judge inspects every candidate worktree (diff + log) and ranks; picks the winner' },
  ],
}

// args: { task: { message, task_class?, task_type? }, agents: [agentId, ...],
//         defaults?, dispatcherModel?, judgeModel? }
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch {
    input = {}
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
const tasks = agents.map((a) => ({
  label: `compete:${a}`,
  task_name: task.task_name || task.label || task.name || task.title || 'tournament-candidate',
  branch_type: task.branch_type || defaults.branch_type,
  initial_agent: a,
  task_class: task.task_class || defaults.task_class || 'STANDARD',
  task_type: task.task_type || defaults.task_type || 'implement_small',
  use_worktree: true, // judging compares per-candidate branches, so each needs its own worktree
  message: task.message,
}))
const fan = await workflow(
  'penumbra-fanout',
  { tasks, defaults, dispatcherModel },
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
