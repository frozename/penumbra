export const meta = {
  name: 'penumbra-fix-until-green',
  description: 'Dispatch an implementation task to the penumbra fleet, then loop: each round the worker runs a check command and reports PASS/FAIL; on FAIL, re-dispatch building on the previous branch with the failure log, until green or the round cap. Optionally escalate to a stronger agent on the final round. Maestro lands the final green branch.',
  whenToUse: 'When a change must satisfy a concrete check (typecheck, a test slice, a lint gate) and may need more than one attempt. Pass args.task.message + args.check (the shell command), optionally args.agent / args.escalateTo / args.maxRounds. Nothing is landed.',
  phases: [
    { title: 'Iterate', detail: 'dispatch → worker runs the check → on FAIL re-dispatch on the prior branch with the failure log; until green or capped' },
  ],
}

// args: { task: { message, task_class?, task_type? }, check: 'bun run typecheck',
//         agent?, escalateTo?, maxRounds?, base?, defaults?, dispatcherModel? }
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
const check = input.check
if (!task || !task.message || !check) {
  log('penumbra-fix-until-green: need args.task.message and args.check (shell command, e.g. "bun run typecheck").')
  return { ok: false, error: 'missing_task_or_check' }
}
const defaults = input.defaults || {}
const dispatcherModel = input.dispatcherModel || 'haiku'
const baseAgent = input.agent || defaults.initial_agent || 'AUTO'
const escalateTo = input.escalateTo // optional stronger agent for the final round
const maxRounds = input.maxRounds || 3
const base = input.base || 'main'

function roundMessage(roundIndex, prevBranch, prevOutput) {
  const head =
    roundIndex === 0
      ? task.message
      : `A previous attempt (branch ${prevBranch}) still fails the check. Build on that branch and fix it.\n\nOriginal task:\n${task.message}\n\nLast failure output:\n${prevOutput || '(none captured)'}`
  return [
    head,
    '',
    'When done, run this check in the repo:',
    `    ${check}`,
    'If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.',
    'IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.',
  ].join('\n')
}

function parseCheck(responseText) {
  const text = String(responseText || '')
  if (/CHECK_RESULT:\s*PASS/i.test(text)) return { passed: true, output: '' }
  // FAIL, or no marker at all → treat as not-green so the loop retries.
  return { passed: false, output: text.slice(-4000) }
}

phase('Iterate')
const rounds = []
let prevBranch = null
let prevOutput = null

for (let i = 0; i < maxRounds; i++) {
  const agentForRound = i === maxRounds - 1 && escalateTo ? escalateTo : baseAgent
  const t = {
    label: `fix#${i + 1}:${agentForRound}`,
    initial_agent: agentForRound,
    task_class: task.task_class || defaults.task_class || 'STANDARD',
    task_type: task.task_type || defaults.task_type || 'implement_small',
    message: roundMessage(i, prevBranch, prevOutput),
  }
  if (i === 0) {
    if (base && base !== 'main') t.branch_base = base
  } else {
    t.branch_base = prevBranch
  }

  const fan = await workflow(
    { scriptPath: '.claude/workflows/penumbra-fanout.js' },
    { tasks: [t], defaults, dispatcherModel },
  )
  const r = ((fan && fan.results) || [])[0]
  if (!r || !r.ok || !r.branch) {
    rounds.push({ round: i + 1, agent: agentForRound, dispatch_ok: false, result: r || null })
    log(`fix-until-green round ${i + 1}: dispatch failed; stopping.`)
    break
  }

  const verdict = parseCheck(r.response)
  rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, passed: verdict.passed })
  prevBranch = r.branch
  prevOutput = verdict.output
  log(`fix-until-green round ${i + 1}: ${verdict.passed ? 'PASS' : 'FAIL'} on ${r.branch}`)
  if (verdict.passed) {
    return { ok: true, green: true, rounds_used: i + 1, final_branch: r.branch, rounds, check }
  }
}

return {
  ok: false,
  green: false,
  rounds_used: rounds.length,
  final_branch: prevBranch,
  last_output: prevOutput,
  rounds,
  check,
}
