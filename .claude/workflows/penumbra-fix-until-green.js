export const meta = {
  name: 'penumbra-fix-until-green',
  description: 'Dispatch an implementation task to the penumbra fleet, then loop: each round the worker runs a check command and reports PASS/FAIL; on FAIL, re-dispatch building on the previous branch with the failure log, until green or the round cap. Optionally run an independent rubric grader after a PASS; rubric failures count as FAIL and feed the next round. Optionally escalate to a stronger agent on the final round. Maestro lands the final green branch.',
  whenToUse: 'When a change must satisfy a concrete check (typecheck, a test slice, a lint gate) and may need more than one attempt. Pass args.task.message + args.check (the shell command), optionally args.rubric / args.graderModel / args.agent / args.escalateTo / args.maxRounds. Nothing is landed.',
  phases: [
    { title: 'Iterate', detail: 'dispatch → worker runs the check → optional independent rubric grade after PASS → on FAIL re-dispatch on the prior branch with the failure log; until green or capped' },
  ],
}

// args: { task: { message, task_class?, task_type? }, check: 'bun run typecheck',
//         rubric?: string[], agent?, escalateTo?, maxRounds?, base?, defaults?,
//         dispatcherModel?, graderModel? }
// graderModel defaults to 'sonnet'; pass graderModel:'inherit' to use the session-default model.
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
const dispatcherModel = input.dispatcherModel || 'sonnet'
const graderModel = input.graderModel
const baseAgent = input.agent || defaults.initial_agent || 'AUTO'
const escalateTo = input.escalateTo // optional stronger agent for the final round
const maxRounds = input.maxRounds || 3
const base = input.base || 'main'
const rubric = Array.isArray(input.rubric) ? input.rubric.filter((c) => typeof c === 'string' && c.trim().length > 0) : []

const RUBRIC_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'pass', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          pass: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

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
  // The worker is told to BEGIN its final message with the marker, so only the first
  // non-empty line counts — avoids a false PASS from the marker echoed inside
  // instructions or failure output.
  const firstLine = (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)) || ''
  if (/^CHECK_RESULT:\s*PASS\b/i.test(firstLine)) return { passed: true, output: '' }
  return { passed: false, output: text.slice(-4000) }
}

function rubricPrompt(branch, handoffId) {
  return [
    `You are an independent rubric grader. Your job is to REFUTE the work, not confirm it. Do not edit, dispatch, land, push, or alter branches.`,
    ``,
    `Original task:`,
    task.message,
    ``,
    `The worker reported CHECK_RESULT: PASS for this command:`,
    check,
    ``,
    `Candidate branch: ${branch}`,
    `Handoff id: ${handoffId}`,
    ``,
    `Inspect the worktree diff with mcp__penumbra__worktree_inspect({ handoff_id: "${handoffId}" }) and any read-only git commands needed to understand the branch. Grade every rubric criterion below against the actual diff and task intent.`,
    rubric.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    ``,
    `For each criterion, pass=true only when the diff clearly satisfies it. Evidence must cite concrete files, hunks, command output, or observed diff facts. Return RUBRIC_RESULT with one item per criterion.`,
  ].join('\n')
}

function rubricFailureOutput(grade) {
  const failed = ((grade && grade.criteria) || []).filter((c) => !c.pass)
  const seen = new Set(((grade && grade.criteria) || []).map((c) => c.criterion))
  const missing = rubric.filter((c) => !seen.has(c))
  if (!failed.length && !missing.length) return ''
  return [
    'The check command passed, but independent rubric grading failed these criteria:',
    ...failed.map((c) => `- ${c.criterion}: ${c.evidence || '(no evidence provided)'}`),
    ...missing.map((c) => `- ${c}: grader did not return this criterion`),
  ].join('\n')
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
  prevBranch = r.branch
  prevOutput = verdict.output
  log(`fix-until-green round ${i + 1}: ${verdict.passed ? 'PASS' : 'FAIL'} on ${r.branch}`)
  if (verdict.passed) {
    if (rubric.length > 0) {
      const grade = await agent(rubricPrompt(r.branch, r.handoff_id), {
        label: `rubric#${i + 1}`,
        phase: 'Iterate',
        schema: RUBRIC_RESULT,
        ...(graderModel === 'inherit' ? {} : { model: graderModel || 'sonnet' }),
      })
      const failedOutput = rubricFailureOutput(grade)
      const rubricPassed = !failedOutput
      rounds.push({
        round: i + 1,
        agent: agentForRound,
        branch: r.branch,
        handoff_id: r.handoff_id,
        passed: rubricPassed,
        check_passed: true,
        rubric_grade: grade,
      })
      log(`fix-until-green round ${i + 1}: rubric ${rubricPassed ? 'PASS' : 'FAIL'} on ${r.branch}`)
      if (rubricPassed) {
        return { ok: true, green: true, rounds_used: i + 1, final_branch: r.branch, rounds, check, rubric }
      }
      prevOutput = failedOutput
    } else {
      rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, passed: true })
      return { ok: true, green: true, rounds_used: i + 1, final_branch: r.branch, rounds, check }
    }
  } else {
    rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, passed: false })
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
  rubric,
}
