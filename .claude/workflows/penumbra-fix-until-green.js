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
  workflowName: 'penumbra-fix-until-green',
  input,
  topLevelAllowedKeys: [
    'task',
    'check',
    'rubric',
    'agent',
    'escalateTo',
    'maxRounds',
    'base',
    'defaults',
    'dispatcherModel',
    'graderModel',
    'project_id',
    'caller_cwd',
    'repo',
  ],
  requiredTopLevelKeys: ['task', 'check'],
  defaults: input.defaults,
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
  ],
  tasks: input.task ? [input.task] : [],
  requireTasks: true,
  taskLocationPrefix: 'task',
  taskAllowedKeys: [
    'message',
    'task_name',
    'label',
    'name',
    'title',
    'branch_type',
    'task_class',
    'task_type',
    'response_mode',
  ],
  taskRequiredKeys: ['message'],
})

const task = input.task
const check = input.check
if (!task || !task.message || !check) {
  log('penumbra-fix-until-green: need args.task.message and args.check (shell command, e.g. "bun run typecheck").')
  return { ok: false, error: 'missing_task_or_check' }
}
const defaults = input.defaults || {}
const fanoutDefaults = { ...defaults }
if (input.project_id !== undefined) fanoutDefaults.project_id = input.project_id
if (input.caller_cwd !== undefined) fanoutDefaults.caller_cwd = input.caller_cwd
const dispatcherModel = input.dispatcherModel || 'sonnet'
const graderModel = input.graderModel
const baseAgent = input.agent || defaults.initial_agent || 'executor' // role-routed default; args.agent and escalateTo are deliberate pins
const escalateTo = input.escalateTo // optional stronger agent for the final round
const maxRounds = input.maxRounds || 3
const base = input.base || 'main'
const rubric = Array.isArray(input.rubric) ? input.rubric.filter((c) => typeof c === 'string' && c.trim().length > 0) : []

const RUBRIC_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    overall_pass: {
      type: 'boolean',
      description: 'explicit verdict for the whole rubric; decide from this field',
    },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'criterion', 'pass', 'evidence'],
        properties: {
          index: { type: 'integer' },
          criterion: { type: 'string' },
          pass: { type: 'boolean' },
          evidence: { type: 'string', maxLength: 600 },
        },
      },
    },
    notes: { type: 'string', maxLength: 600 },
  },
}

// The worker is the check runner. To keep bash constructs (e.g. `for n in $files`)
// from being misinterpreted by a default zsh shell, always spawn the check via bash -c.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function bashCheckCommand(cmd) {
  return `bash -c ${shellQuote(cmd)}`
}

function roundMessage(roundIndex, prevBranch, prevOutput) {
  const head =
    roundIndex === 0
      ? task.message
      : `A previous attempt (branch ${prevBranch}) still fails the check. Build on that branch and fix it.\n\nOriginal task:\n${task.message}\n\nLast failure output:\n${prevOutput || '(none captured)'}`
  return [
    head,
    '',
    'When done, run this check in the repo by spawning bash with the command as a single argument:',
    `    ${bashCheckCommand(check)}`,
    'If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.',
    'IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.',
  ].join('\n')
}

function parseCheck(result) {
  const hasLeanFields = result && typeof result === 'object' && typeof result.check_line === 'string'
  const text = hasLeanFields ? String(result.check_line || '') : String(result || '')
  // CommonMark fences open with <=3 leading spaces plus 3+ matching ticks/tildes;
  // only an equal-or-longer run of the same marker character closes them.
  const scanText = stripFencedBlocks(text)
  let sawPass = false
  let sawFail = false
  for (const line of scanText.split('\n')) {
    // Marker must be line-initial with <=3 leading spaces, matching the
    // CommonMark indented-code-block boundary used by fence scanning.
    const marker = /^ {0,3}CHECK_RESULT:\s*(PASS|FAIL)\b/i.exec(line)
    if (!marker) continue
    if (marker[1].toUpperCase() === 'FAIL') sawFail = true
    if (marker[1].toUpperCase() === 'PASS') sawPass = true
  }
  if (!sawFail && sawPass) return { passed: true, output: '' }
  if (hasLeanFields) {
    return { passed: false, output: String(result.failure_tail || result.response || result.check_line || '').slice(-4000) }
  }
  return { passed: false, output: text.slice(-4000) }
}

function stripFencedBlocks(text) {
  const visibleLines = []
  let fence = null

  for (const line of String(text).split('\n')) {
    const fenceLine = /^( {0,3})(`{3,}|~{3,})/.exec(line)
    if (!fence) {
      if (fenceLine) {
        const marker = fenceLine[2]
        fence = { char: marker[0], length: marker.length }
        continue
      }
      visibleLines.push(line)
      continue
    }

    if (fenceLine) {
      const marker = fenceLine[2]
      const closesFence =
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        line.slice(fenceLine[1].length + marker.length).trim().length === 0
      if (closesFence) {
        fence = null
      }
    }
  }

  return visibleLines.join('\n')
}

function hopFields(result) {
  if (!result) {
    return {
      root_handoff_id: null,
      latest_handoff_id: null,
      hop_count: 0,
      extra_hops: 0,
      retry_prompt_count: 0,
      hops_incomplete: false,
      branch_base: null,
      parent_handoff_id: null,
      hops: [],
    }
  }
  return {
    root_handoff_id: result.root_handoff_id || null,
    latest_handoff_id: result.latest_handoff_id || null,
    hop_count: result.hop_count || 0,
    extra_hops: result.extra_hops || 0,
    retry_prompt_count: result.retry_prompt_count || 0,
    hops_incomplete: result.hops_incomplete === true,
    branch_base: result.branch_base || null,
    parent_handoff_id: result.parent_handoff_id || null,
    hops: Array.isArray(result.hops) ? result.hops : [],
  }
}

function rubricPrompt(branch, handoffId) {
  const title = task.title || task.task_name || task.label || task.name || 'Untitled task'
  const messagePreview = `${String(task.message || '').slice(0, 400)}…`
  return [
    `You are an independent rubric grader. Your job is to REFUTE the work, not confirm it. Do not edit, dispatch, land, push, or alter branches.`,
    ``,
    `Original task:`,
    `Title: ${title}`,
    `Message preview: ${messagePreview}`,
    ``,
    `The worker reported CHECK_RESULT: PASS for this command:`,
    check,
    ``,
    `Candidate branch: ${branch}`,
    `Handoff id: ${handoffId}`,
    ``,
    `Inspect the worktree diff with mcp__penumbra__worktree_inspect({ handoff_id: "${handoffId}" }) and run git diff --stat first. Read only the hunks needed to grade the rubric-relevant changes. Grade every rubric criterion below against the actual diff and task intent.`,
    rubric.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    ``,
    `For each criterion, pass=true only when the diff clearly satisfies it. Evidence must cite concrete files, hunks, command output, or observed diff facts. Return RUBRIC_RESULT with an explicit boolean "overall_pass" verdict, plus exactly one item per criterion: index is the criterion's number in the list above, and criterion is its text verbatim.`,
  ].join('\n')
}

// rubric-match:begin
function normalizeRubricCriterion(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\s*\d+\s*[.):-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .trim()
}

function matchRubricGrade(rubric, grade) {
  const normalizedRubric = rubric.map((criterion) => normalizeRubricCriterion(criterion))
  const buckets = rubric.map(() => [])
  const criteria = Array.isArray(grade && grade.criteria) ? grade.criteria : []

  for (const item of criteria) {
    const index = item && Number.isInteger(item.index) && item.index >= 1 && item.index <= rubric.length ? item.index - 1 : -1
    let matchIndex = index

    if (matchIndex < 0) {
      const normalizedCriterion = normalizeRubricCriterion(item && item.criterion)
      matchIndex = normalizedRubric.findIndex((criterion) => criterion && criterion === normalizedCriterion)

      if (matchIndex < 0 && normalizedCriterion) {
        const containmentMatches = normalizedRubric
          .map((criterion, rubricIndex) => ({ criterion, rubricIndex }))
          .filter(({ criterion }) => criterion && (criterion.includes(normalizedCriterion) || normalizedCriterion.includes(criterion)))
        if (containmentMatches.length === 1) {
          matchIndex = containmentMatches[0].rubricIndex
        }
      }
    }

    if (matchIndex >= 0) {
      buckets[matchIndex].push(item)
    }
  }

  const missing = []
  const results = rubric.map((criterion, rubricIndex) => {
    const items = buckets[rubricIndex]
    if (!items.length) {
      missing.push(criterion)
      return { index: rubricIndex + 1, criterion, pass: false, evidence: '' }
    }
    return {
      index: rubricIndex + 1,
      criterion,
      pass: items.every((item) => item && item.pass === true),
      evidence: items
        .map((item) => String((item && item.evidence) || '').trim())
        .filter((evidence) => evidence.length > 0)
        .join('; '),
    }
  })

  return { results, missing }
}
// rubric-match:end

// Rubric verdict contract: decide from the explicit `overall_pass` boolean when
// it is present; otherwise fall back to requiring every `criteria[i].pass` to be
// `true`. Never infer PASS/FAIL by string-matching `notes` or the exact-text matcher.
function rubricVerdict(grade) {
  if (grade && typeof grade.overall_pass === 'boolean') {
    return grade.overall_pass
  }
  const criteria = Array.isArray(grade && grade.criteria) ? grade.criteria : []
  return criteria.length > 0 && criteria.every((c) => c && c.pass === true)
}

function rubricFailureOutput(grade) {
  if (rubricVerdict(grade)) return ''
  const matched = matchRubricGrade(rubric, grade)
  const missing = matched.missing
  const missingSet = new Set(missing)
  const failed = matched.results.filter((c) => !c.pass && !missingSet.has(c.criterion))

  const lines = ['The check command passed, but independent rubric grading failed these criteria:']
  for (const c of failed) {
    lines.push(`- ${c.criterion}: ${c.evidence || '(no evidence provided)'}`)
  }
  for (const c of missing) {
    lines.push(`- ${c}: grader did not return this criterion`)
  }
  if (!failed.length && !missing.length) {
    lines.push('The rubric grader returned overall_pass=false or an incomplete result.')
    if (grade && grade.notes) {
      lines.push(`Grader notes: ${grade.notes}`)
    }
  }
  return lines.join('\n')
}

phase('Iterate')
const rounds = []
let prevBranch = null
let prevOutput = null

for (let i = 0; i < maxRounds; i++) {
  const agentForRound = i === maxRounds - 1 && escalateTo ? escalateTo : baseAgent
  const t = {
    label: `fix#${i + 1}:${agentForRound}`,
    task_name: task.task_name || task.label || task.name || task.title || `fix-${i + 1}`,
    branch_type: task.branch_type || defaults.branch_type,
    initial_agent: agentForRound,
    task_class: task.task_class || defaults.task_class || 'STANDARD',
    task_type: task.task_type || defaults.task_type || 'implement_small',
    response_mode: 'first_line',
    message: roundMessage(i, prevBranch, prevOutput),
  }
  if (i === 0) {
    if (base && base !== 'main') t.branch_base = base
  } else {
    t.branch_base = prevBranch
  }

  const fan = await workflow(
    'penumbra-fanout',
    { tasks: [t], defaults: fanoutDefaults, dispatcherModel, ...(input.repo !== undefined ? { repo: input.repo } : {}) },
  )
  const r = ((fan && fan.results) || [])[0]
  if (!r || !r.ok || !r.branch) {
    rounds.push({ round: i + 1, agent: agentForRound, dispatch_ok: false, result: r || null, ...hopFields(r) })
    log(`fix-until-green round ${i + 1}: dispatch failed; stopping.`)
    break
  }

  const verdict = parseCheck(r && Object.prototype.hasOwnProperty.call(r, 'check_line') ? r : r.response)
  prevBranch = r.branch
  prevOutput = verdict.output
  if (r.extra_hops > 0 || r.hops_incomplete === true) {
    log(`WARNING: fix-until-green round ${i + 1}: ignored ${r.extra_hops || 0} extra hop(s) for branch selection; retry_prompt_count=${r.retry_prompt_count || 0} hops_incomplete=${r.hops_incomplete === true}; using root_handoff_id=${r.root_handoff_id} branch=${r.branch}`)
  }
  log(`fix-until-green round ${i + 1}: ${verdict.passed ? 'PASS' : 'FAIL'} on ${r.branch}`)
  if (verdict.passed) {
    if (rubric.length > 0) {
      const grade = await agent(rubricPrompt(r.branch, r.handoff_id), {
        label: `rubric#${i + 1}`,
        phase: 'Iterate',
        schema: RUBRIC_RESULT,
        effort: 'low',
        ...(graderModel === 'inherit' ? {} : { model: graderModel || 'sonnet' }),
      })
      // Decide from the grader's explicit overall_pass when present;
      // fall back to all(criteria.pass). Never infer from the notes string.
      const rubricPassed = rubricVerdict(grade)
      const failedOutput = rubricPassed ? '' : rubricFailureOutput(grade)
      rounds.push({
        round: i + 1,
        agent: agentForRound,
        branch: r.branch,
        handoff_id: r.handoff_id,
        ...hopFields(r),
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
      rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, ...hopFields(r), passed: true })
      return { ok: true, green: true, rounds_used: i + 1, final_branch: r.branch, rounds, check }
    }
  } else {
    rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, ...hopFields(r), passed: false })
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
