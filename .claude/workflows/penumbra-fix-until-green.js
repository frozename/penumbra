export const meta = {
  name: 'penumbra-fix-until-green',
  description: 'Dispatch an implementation task to the penumbra fleet, then loop: each round the worker runs a check command and reports PASS/FAIL; on FAIL, re-dispatch building on the previous branch with the failure log, until green or the round cap. Optionally run an independent rubric grader after a PASS; rubric failures count as FAIL and feed the next round. Optionally escalate to a stronger agent on the final round. Maestro lands the final green branch.',
  whenToUse: 'When a change must satisfy a concrete check (typecheck, a test slice, a lint gate) and may need more than one attempt. Pass args.task.message + args.check (the shell command), optionally args.rubric / args.graderModel / args.agent / args.escalateTo / args.maxRounds. Nothing is landed. Every rubric criterion must be checkable from the candidate diff alone: the grader never sees the worker reply, so a criterion such as the worker reported a proof can never pass and only burns rounds. Run it as the top-level Workflow: it nests penumbra-fanout through workflow(), and workflow() cannot be called from within a child workflow.',
  phases: [
    { title: 'Iterate', detail: 'dispatch → worker runs the check → optional independent rubric grade after PASS → on FAIL re-dispatch on the prior branch with the failure log; until green or capped' },
  ],
}

// args: { task: { message, task_class?, task_type? }, check: 'bun run typecheck',
//         rubric?: string[], agent?, escalateTo?, maxRounds?, base?, defaults?,
//         dispatcherModel?, agentType?, graderModel?, parityCheck?: 'bun run check:ci' }
// agentType: the fanout proxy agent type; omit it to use penumbra:penumbra-fanout-proxy, or pass 'inherit' for the generic proxy.
// parityCheck requires the independent verifier (verifyCheck on by default); combining
// it with verifyCheck:false is rejected because the parity gate would never run.
// graderModel defaults to 'sonnet'; pass graderModel:'inherit' to use the session-default model.
// Composition: run this as the top-level Workflow. Every round calls workflow('penumbra-fanout'), and workflow() cannot be called from within a child workflow; penumbra-loop-discover-to-green inlines this loop for that reason.
// Rubric: the grader reads only the candidate diff (worktree_inspect, else git -C <repo> diff <base>...<branch>, with the repo from args.repo or caller_cwd). Write every criterion so the diff alone can prove it. A grader that cannot read the diff reports GRADER_UNAVAILABLE.
// Rubric verdict: green only when the grade has inspected:true and every criterion is graded exactly once and passes. overall_pass does not decide; when it disagrees with the criteria the round logs it and records rubric_overall_disagreement:true.
// A reply without a CHECK_RESULT marker is UNKNOWN: with verifyCheck on, the independent verifier's check_exit decides the round; otherwise it is a FAIL.
// A missing penumbra:penumbra-fanout-proxy agent stops round 1 with reason proxy_not_installed.
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
    'parityCheck',
    'rubric',
    'agent',
    'escalateTo',
    'verifyCheck',
    'maxRounds',
    'base',
    'defaults',
    'dispatcherModel',
    'agentType',
    'graderModel',
    'verifierModel',
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
    'isolated_install',
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
const verifierModel = input.verifierModel || 'sonnet'
const baseAgent = input.agent || defaults.initial_agent || 'executor' // role-routed default; args.agent and escalateTo are deliberate pins
const escalateTo = input.escalateTo // optional stronger agent for the final round
const verifyCheck = input.verifyCheck !== false // default ON: a round passes only when an independent verifier re-runs the CHECK. Opt out explicitly with verifyCheck:false.
// Optional CI-parity command (e.g. 'bun run check:ci'); when set, the independent
// verifier also runs it in the same worktree and the round only passes when both
// check and parity exit 0.
const parityCheck = typeof input.parityCheck === 'string' && input.parityCheck.trim().length > 0 ? input.parityCheck : null
if (parityCheck !== null && !verifyCheck) {
  log('penumbra-fix-until-green: parityCheck is measured by the independent CHECK verifier; refusing parityCheck with verifyCheck:false.')
  return { ok: false, error: 'parity_check_requires_verify_check' }
}
const maxRounds = Math.max(0, input.maxRounds ?? 3)
const base = input.base || 'main'
const rubricBase = input.base || (typeof defaults.branch_base === 'string' && defaults.branch_base) || 'main'
const rubric = Array.isArray(input.rubric) ? input.rubric.filter((c) => typeof c === 'string' && c.trim().length > 0) : []
const PROXY_NOT_INSTALLED_HINT = "The fanout proxy agent penumbra:penumbra-fanout-proxy is not available in this session (the Penumbra Claude Code plugin ships it as plugin/agents/penumbra-fanout-proxy.md). Install or enable that plugin and start a new Claude Code session, or pass agentType: 'inherit' to opt in to the generic proxy, which can run Bash."

const RUBRIC_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria', 'inspected'],
  properties: {
    overall_pass: {
      type: 'boolean',
      description: 'must equal "every criterion passed"; cautions belong in notes, and the verdict comes from the per-criterion grades',
    },
    inspected: {
      type: 'boolean',
      description: 'true only when you located and read the candidate diff; false means the rubric was not graded',
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

const CHECK_VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: parityCheck ? ['ran', 'check_exit', 'parity_exit'] : ['ran', 'check_exit'],
  properties: {
    ran: { type: 'boolean', description: 'true iff you actually executed the CHECK command to completion' },
    check_exit: { type: 'integer', description: 'exit code of the CHECK run verbatim in the worktree; -1 if it could not be run' },
    ...(parityCheck
      ? { parity_exit: { type: 'integer', description: 'exit code of the PARITY command run verbatim in the same worktree after the CHECK; -1 if it could not be run' } }
      : {}),
    failing_segment: { type: 'string', description: parityCheck ? 'the && segment that failed (CHECK or PARITY), verbatim, or empty when both exit 0' : 'the && segment that failed, verbatim, or empty when check_exit is 0' },
    output_tail: { type: 'string', description: parityCheck ? 'last ~2000 characters of the output of whichever command failed (CHECK or PARITY)' : 'last ~2000 characters of the CHECK output' },
    notes: { type: 'string' },
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
  const lines = [
    head,
    '',
    'When done, run this check in the repo by spawning bash with the command as a single argument:',
    `    ${bashCheckCommand(check)}`,
  ]
  if (parityCheck !== null) {
    lines.push(
      '',
      'Then run this parity command the same way; it replays the blocking CI steps and can take several minutes:',
      `    ${bashCheckCommand(parityCheck)}`,
    )
  }
  lines.push(
    parityCheck !== null
      ? 'If either command fails, fix and re-run until both pass or you cannot make further progress. Commit your work on the worktree branch.'
      : 'If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.',
    parityCheck !== null
      ? 'IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. Report PASS only when BOTH commands exit 0; when either fails report FAIL and follow it with the last ~50 lines of the failing output inside a fenced ``` block.'
      : 'IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.',
  )
  return lines.join('\n')
}

function parseCheck(result, responseMode = 'first_line') {
  const isObject = result !== null && typeof result === 'object'
  const checkLine = isObject && typeof result.check_line === 'string' ? result.check_line : null
  const response = isObject && typeof result.response === 'string' ? result.response : null
  const failureTail = isObject && typeof result.failure_tail === 'string' ? result.failure_tail : ''
  // check_line is optional in the fanout result schema; when it and the response are
  // both absent, failure_tail is the only text that can carry an explicit FAIL.
  const useFirstLine = responseMode === 'first_line' && isObject && (checkLine !== null || response === null)
  if (!useFirstLine && responseMode !== 'first_line') {
    log(`WARNING: fix-until-green: response_mode is ${responseMode}; check parsing will scan the full worker response for CHECK_RESULT rather than only the first line.`)
  }
  // Never stringify the result object itself: it would scan and report "[object Object]".
  // Without a response, failure_tail and check_line are the only text that can carry an
  // explicit FAIL. A PASS there is not trusted, as in the first_line failure_tail scan,
  // because the response this mode asked for never arrived.
  const responseMissing = !useFirstLine && isObject && response === null
  const text = useFirstLine
    ? checkLine || ''
    : response !== null
      ? response
      : isObject
        ? failureTail || checkLine || ''
        : String(result || '')
  // check_line and failure_tail are separate fragments; scanning them apart keeps a fence
  // left open in one from hiding a marker in the other.
  const scanSources = responseMissing ? [failureTail, checkLine || ''] : [text]
  let sawPass = false
  let sawFail = false
  for (const scanSource of scanSources) {
    // CommonMark fences open with <=3 leading spaces plus 3+ matching ticks/tildes;
    // only an equal-or-longer run of the same marker character closes them.
    for (const line of stripFencedBlocks(scanSource).split('\n')) {
      // Marker must be line-initial with <=3 leading spaces, matching the
      // CommonMark indented-code-block boundary used by fence scanning.
      const marker = /^ {0,3}CHECK_RESULT:\s*(PASS|FAIL)\b/i.exec(line)
      if (!marker) continue
      if (marker[1].toUpperCase() === 'FAIL') sawFail = true
      if (marker[1].toUpperCase() === 'PASS' && !responseMissing) sawPass = true
    }
  }
  if (!sawFail && sawPass) return { passed: true, output: '' }
  let fullSawPass = false
  let fullSawFail = false
  const fallbackText = response !== null ? response : failureTail
  if (useFirstLine && !sawFail && !sawPass && fallbackText) {
    const fullScan = stripFencedBlocks(fallbackText)
    for (const line of fullScan.split('\n')) {
      const marker = /^ {0,3}CHECK_RESULT:\s*(PASS|FAIL)\b/i.exec(line)
      if (!marker) continue
      if (marker[1].toUpperCase() === 'FAIL') fullSawFail = true
      if (marker[1].toUpperCase() === 'PASS' && response !== null) fullSawPass = true
    }
    if (response !== null && !fullSawFail && fullSawPass) {
      log('fix-until-green: check_line held no CHECK_RESULT marker (worker narrated first); recovered the verdict from the full response.')
      return { passed: true, output: '' }
    }
  }
  // No line-initial, unfenced marker anywhere: UNKNOWN, not FAIL.
  const unknown = !sawPass && !sawFail && !fullSawPass && !fullSawFail
  if (useFirstLine) {
    return { passed: false, ...(unknown ? { unknown: true } : {}), output: (failureTail || response || checkLine || '').slice(-4000) }
  }
  return { passed: false, ...(unknown ? { unknown: true } : {}), output: text.slice(-4000) }
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

// The repository root is a clone that people and other workflows share, so a grader
// or verifier that moves its HEAD or dirties its tree breaks unrelated work.
function readOnlyRule(repoRoot, allowWorktreeList) {
  const git = repoRoot ? `git -C ${shellQuote(repoRoot)}` : 'git -C <repo>'
  const allowed = `${git} diff|show|log|rev-parse|ls-tree${allowWorktreeList ? ` and ${git} worktree list` : ''}`
  return `Read-only rule: in the repository root use only ${allowed}. Never run checkout, switch, reset, stash, clean, commit, branch, worktree add or worktree remove, in the repository root or in any other checkout.${allowWorktreeList ? ' Running the CHECK verbatim inside the dispatch worktree is allowed even when the CHECK itself invokes git.' : ''}`
}

function rubricPrompt(branch, handoffId, repoRoot, worktreePath) {
  const title = task.title || task.task_name || task.label || task.name || 'Untitled task'
  const messagePreview = `${String(task.message || '').slice(0, 400)}…`
  const git = repoRoot ? `git -C ${shellQuote(repoRoot)}` : null
  const range = shellQuote(`${rubricBase}...${branch}`)
  return [
    `You are an independent rubric grader. Your job is to REFUTE the work, not confirm it. Do not edit, dispatch, land, push, or alter branches.`,
    readOnlyRule(repoRoot, false),
    'Grade from the diff alone: do not run the CHECK command, tests, builds or installs. The independent CHECK verifier measures the CHECK.',
    ``,
    `Original task:`,
    `Title: ${title}`,
    `Message preview: ${messagePreview}`,
    ``,
    `The CHECK command below passed (worker report or independent verifier):`,
    check,
    ``,
    `Candidate branch: ${branch}`,
    `Handoff id: ${handoffId}`,
    ``,
    ...(repoRoot ? [`Repository root: ${repoRoot}`, `Candidate worktree (derived; it may not exist): ${worktreePath}`] : ['Repository root: unknown (args.repo, args.caller_cwd and defaults.caller_cwd are unset or relative).']),
    `Inspect the worktree diff with mcp__penumbra__worktree_inspect({ handoff_id: "${handoffId}" }).`,
    git ? `If worktree_inspect fails or returns not_found, read the diff with ${git} diff --stat ${range} and then ${git} diff ${range} -- <path>. Run every diff as ${git}, never from your own working directory, which can be a different repository.` : 'If worktree_inspect fails, return inspected:false: without a repository root the candidate cannot be located safely.',
    'If you cannot read the candidate diff, return inspected:false with an empty criteria array and say why in notes. Set inspected:true only after you have read the candidate diff.',
    'Read only the hunks needed to grade the rubric-relevant changes. Grade every rubric criterion below against the actual diff and task intent.',
    rubric.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    ``,
    `For each criterion, pass=true only when the diff clearly satisfies it. Evidence must cite concrete files, hunks, or observed diff facts. Return RUBRIC_RESULT with exactly one item per criterion: index is the criterion's number in the list above, and criterion is its text verbatim.`,
    `overall_pass must equal "every criterion passed": true when every item has pass=true, false otherwise. Put cautions, nits and reservations in notes, never in overall_pass; the verdict is taken from the per-criterion grades.`,
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

  const extra = []
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
    } else {
      extra.push({ criterion: String((item && item.criterion) || ''), reason: 'unknown' })
    }
  }

  const missing = []
  const results = rubric.map((criterion, rubricIndex) => {
    const items = buckets[rubricIndex]
    if (!items.length) {
      missing.push(criterion)
      return { index: rubricIndex + 1, criterion, pass: false, evidence: '' }
    }
    if (items.length > 1) {
      extra.push({ criterion, reason: 'duplicate' })
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

  return { results, missing, extra }
}
// rubric-match:end

// Rubric verdict contract: the caller has already required inspected:true; the
// rubric is green only when no grader item is a duplicate or unknown and every
// rubric criterion passes (a missing criterion never passes). overall_pass does
// not decide: graders have set it false on fully passing work to flag a caution,
// and true over empty or failing criteria. Never infer PASS/FAIL from `notes`.
function rubricVerdict(grade) {
  const matched = matchRubricGrade(rubric, grade)
  return matched.extra.length === 0 && matched.results.every((c) => c.pass)
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
  for (const item of matched.extra) {
    lines.push(item.reason === 'duplicate' ? `- ${item.criterion}: grader returned this criterion more than once` : `- ${item.criterion || '(blank)'}: grader returned a criterion that is not in the rubric`)
  }
  if (grade && grade.notes) {
    lines.push(`Grader notes: ${grade.notes}`)
  }
  return lines.join('\n')
}

phase('Iterate')
const rounds = []
let prevBranch = null
let prevOutput = null
let consecutiveVerifyNotRun = 0

for (let i = 0; i < maxRounds; i++) {
  const agentForRound = i === maxRounds - 1 && escalateTo ? escalateTo : baseAgent
  const responseMode = task.response_mode || defaults.response_mode || 'first_line'
  const t = {
    label: `fix#${i + 1}:${agentForRound}`,
    task_name: task.task_name || task.label || task.name || task.title || defaults.task_name || `fix-${i + 1}`,
    branch_type: task.branch_type || defaults.branch_type,
    initial_agent: agentForRound,
    task_class: task.task_class || defaults.task_class || 'STANDARD',
    task_type: task.task_type || defaults.task_type || 'implement_small',
    response_mode: responseMode,
    message: roundMessage(i, prevBranch, prevOutput),
  }
  if (i === 0) {
    if (base && base !== 'main') t.branch_base = base
  } else {
    t.branch_base = prevBranch
  }

  const fan = await workflow(
    'penumbra-fanout',
    { tasks: [t], defaults: fanoutDefaults, dispatcherModel, ...(input.agentType !== undefined ? { agentType: input.agentType } : {}), ...(input.repo !== undefined ? { repo: input.repo } : {}) },
  )
  const r = ((fan && fan.results) || [])[0]
  let dispatchFailure = null
  if (!r) {
    dispatchFailure = 'agent_dropped'
  } else if (r.status === 'proxy_error' && r.error_code === 'not_found' && input.agentType === undefined) {
    dispatchFailure = 'proxy_not_installed'
  } else if (![r.conversation_id, r.root_handoff_id || r.handoff_id].some((id) => typeof id === 'string' && id.trim())) {
    dispatchFailure = 'no_dispatch'
  } else if (r.status === 'completed' && r.reliability_trustworthy !== true) {
    // Fanout forces ok=false when its trust gate closes, so a completed chain
    // that is distrusted or never audited must be named before !r.ok flattens
    // it into chain_failed.
    dispatchFailure = 'untrustworthy_dispatch'
  } else if (!r.ok) {
    dispatchFailure = 'chain_failed'
  } else if (!r.branch) {
    dispatchFailure = 'completed_no_branch'
  }
  if (dispatchFailure) {
    const detail = dispatchFailure === 'untrustworthy_dispatch' ? (r.reliability_trustworthy === false ? 'audited and distrusted' : 'never audited') : ''
    const status = dispatchFailure === 'chain_failed' && r && typeof r.status === 'string' && r.status ? ` status=${r.status}` : ''
    const summary = r && typeof r.error_summary === 'string' && r.error_summary ? ` error_summary=${r.error_summary}` : ''
    const hint = dispatchFailure === 'proxy_not_installed' ? PROXY_NOT_INSTALLED_HINT : ''
    rounds.push({ round: i + 1, agent: agentForRound, dispatch_ok: false, reason: dispatchFailure, ...(hint ? { hint } : {}), result: r || null, ...hopFields(r), ci_parity: false })
    if (hint) prevOutput = hint
    log(`fix-until-green round ${i + 1}: ${dispatchFailure}${detail ? ` (${detail})` : ''}${status}${summary}${hint ? ` ${hint}` : ''}; stopping.`)
    break
  }

  const verdict = parseCheck(r, responseMode)
  const verifyMissingMarker = verdict.unknown === true && Boolean(r.branch)
  prevBranch = r.branch
  prevOutput = verdict.output
  if (r.extra_hops > 0 || r.hops_incomplete === true) {
    log(`WARNING: fix-until-green round ${i + 1}: ignored ${r.extra_hops || 0} extra hop(s) for branch selection; retry_prompt_count=${r.retry_prompt_count || 0} hops_incomplete=${r.hops_incomplete === true}; using root_handoff_id=${r.root_handoff_id} branch=${r.branch}`)
  }
  log(`fix-until-green round ${i + 1}: ${verdict.passed ? 'PASS' : verdict.unknown ? 'UNKNOWN (no CHECK_RESULT marker)' : 'FAIL'} on ${r.branch}`)
  const repoRoot = input.repo ?? input.caller_cwd ?? defaults.caller_cwd
  const hasRepoRoot = typeof repoRoot === 'string' && repoRoot.startsWith('/')
  const worktreePath = hasRepoRoot ? `${repoRoot}-worktrees/${r.handoff_id}` : null
  let checkVerified = false
  let checkVerifyStatus = 'skipped'
  if ((verdict.passed || verifyMissingMarker) && verifyCheck) {
    const verifyPrompt = [
      'You are an independent CHECK verifier. Do not edit, commit, push, or land anything.',
      readOnlyRule(hasRepoRoot ? repoRoot : null, true),
      '',
      verdict.passed ? 'The worker claimed PASS. Do not trust that claim — measure it.' : 'The worker final message carried no CHECK_RESULT line, so its result is unknown. Measure the CHECK yourself.',
      '',
      worktreePath
        ? `Run the CHECK only inside the dispatch worktree, which is likely at ${shellQuote(worktreePath)}: try \`cd ${shellQuote(worktreePath)}\` first. If that directory does not exist, locate the worktree with \`git -C ${shellQuote(repoRoot)} worktree list\` and pick the entry for the branch named ${r.branch} (or the handoff id ${r.handoff_id}), then cd to it. If you still cannot locate it, set ran:false, check_exit:-1, and say so in notes; never check the branch out in the repository root or anywhere else to run the CHECK.`
        : `The repository root could not be derived from input.repo, input.caller_cwd, or defaults.caller_cwd. Run the CHECK only inside the dispatch worktree: run \`git worktree list\` from your own working directory and use an entry only if its branch is exactly ${r.branch} (or its path names the handoff id ${r.handoff_id}), then cd to it. If no entry matches, set ran:false, check_exit:-1, and say so in notes; never check the branch out anywhere to run the CHECK.`,
      '',
      'Run this CHECK command VERBATIM by spawning bash with the command as a single argument:',
      `    ${bashCheckCommand(check)}`,
      ...(parityCheck
        ? [
            '',
            'Then run this PARITY command VERBATIM in the same worktree, by spawning bash with the command as a single argument:',
            `    ${bashCheckCommand(parityCheck)}`,
            'The PARITY command replays the blocking CI steps and can take about 7 minutes, which can exceed a single Bash call\'s timeout cap. Run it in the background writing to a log file and poll until the process exits (or run it at the maximum allowed timeout and then keep waiting on the process); never report parity_exit before the PARITY command has exited.',
          ]
        : []),
      '',
      'Report the true exit code as check_exit and set ran:true only if you ran the CHECK to completion.',
      ...(parityCheck
        ? ['Report the PARITY exit code as parity_exit; a round is green only when check_exit and parity_exit are both 0.']
        : []),
      'If the CHECK could not be run, set ran:false and check_exit:-1.',
      parityCheck
        ? 'If the CHECK fails (check_exit is not 0), populate failing_segment with the failing command/segment verbatim and output_tail with the last ~2000 characters of the CHECK output. If the PARITY fails (parity_exit is not 0) while the CHECK passes, populate failing_segment and output_tail from the PARITY run instead.'
        : 'If the CHECK fails (check_exit is not 0), populate failing_segment with the failing command/segment verbatim and output_tail with the last ~2000 characters of the CHECK output.',
    ].join('\n')
    let v
    try {
      v = await agent(verifyPrompt, { label: `verify-check#${i + 1}`, phase: 'Iterate', schema: CHECK_VERIFY_SCHEMA, model: verifierModel })
    } catch {
      v = null
    }
    if (v == null || typeof v !== 'object') {
      checkVerifyStatus = 'unavailable'
      rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, ...hopFields(r), check_verify_status: 'unavailable', check_passed: verdict.passed, verified: false, ci_parity: false, passed: false })
      prevOutput = verdict.passed ? 'Independent CHECK verifier was unavailable; the worker\'s PASS was not attested.' : 'Independent CHECK verifier was unavailable; the round had no CHECK_RESULT marker and was not attested.'
      log(`fix-until-green round ${i + 1}: independent CHECK verifier unavailable; ${verdict.passed ? 'worker PASS not attested' : 'unmarked round not attested'} on ${r.branch}`)
      break
    }
    const parityFailed = parityCheck !== null && v.parity_exit !== 0
    if (v.ran !== true || v.check_exit !== 0 || parityFailed) {
      const verifierRan = v.ran === true
      consecutiveVerifyNotRun = verifierRan ? 0 : consecutiveVerifyNotRun + 1
      checkVerifyStatus = 'failed'
      const failOutput = [v.failing_segment, v.output_tail, v.notes].filter(Boolean).join('\n')
      rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, ...hopFields(r), check_verify_status: 'failed', check_passed: verdict.passed, verified: false, check_exit: v.check_exit, ci_parity: false, passed: false })
      prevOutput = failOutput
      if (verifierRan) {
        log(`fix-until-green round ${i + 1}: ${verdict.passed ? 'worker claimed PASS but' : 'round had no CHECK_RESULT marker and'} the independent CHECK verifier measured check_exit=${v.check_exit}${parityCheck !== null ? ` parity_exit=${v.parity_exit}` : ''}; treating as FAIL`)
      } else {
        log(`fix-until-green round ${i + 1}: the independent CHECK verifier could not run the CHECK (ran=false, check_exit=${v.check_exit}); treating as FAIL`)
      }
      if (consecutiveVerifyNotRun >= 2) {
        log(`fix-until-green: independent CHECK verifier could not run in ${consecutiveVerifyNotRun} consecutive rounds; stopping.`)
        break
      }
      continue
    }
    consecutiveVerifyNotRun = 0
    checkVerified = true
    checkVerifyStatus = 'passed'
  }
  if (verdict.passed || checkVerified) {
    if (rubric.length > 0) {
      let grade
      try {
        grade = await agent(rubricPrompt(r.branch, r.handoff_id, hasRepoRoot ? repoRoot : null, worktreePath), {
          label: `rubric#${i + 1}`,
          phase: 'Iterate',
          schema: RUBRIC_RESULT,
          effort: 'low',
          ...(graderModel === 'inherit' ? {} : { model: graderModel || 'sonnet' }),
        })
      } catch {
        grade = null
      }
      const notInspected = grade != null && grade.inspected !== true
      if (grade == null || notInspected) {
        // Only inspected:false says the diff could not be found; a missing or null
        // flag means the grader never attested that it read the diff at all.
        const graderProblem = grade == null ? 'was unavailable' : grade.inspected === false ? 'could not locate the candidate diff' : 'did not attest that it read the candidate diff'
        const graderUnavailableOutput = `Independent rubric grader ${graderProblem}; rubric not attested.`
        rounds.push({
          round: i + 1,
          agent: agentForRound,
          branch: r.branch,
          handoff_id: r.handoff_id,
          ...hopFields(r),
          check_passed: verdict.passed,
          check_verify_status: checkVerifyStatus,
          rubric_status: 'GRADER_UNAVAILABLE',
          rubric_grade: grade ?? null,
          verified: checkVerified,
          ci_parity: parityCheck !== null && checkVerified,
          passed: false,
        })
        log(`fix-until-green round ${i + 1}: grader ${graderProblem}; rubric not attested on ${r.branch}`)
        prevOutput = graderUnavailableOutput
        break
      }
      const rubricPassed = rubricVerdict(grade)
      // overall_pass is only cross-checked: a disagreement is surfaced for the operator
      // but never turns passing criteria red or feeds a new round.
      const rubricOverallDisagreement = typeof grade.overall_pass === 'boolean' && grade.overall_pass !== rubricPassed
      if (rubricOverallDisagreement) {
        log(`fix-until-green round ${i + 1}: grader overall_pass=${grade.overall_pass} disagrees with its per-criterion grades; the criteria decide (rubric ${rubricPassed ? 'PASS' : 'FAIL'}) on ${r.branch}`)
      }
      const failedOutput = rubricPassed ? '' : rubricFailureOutput(grade)
      rounds.push({
        round: i + 1,
        agent: agentForRound,
        branch: r.branch,
        handoff_id: r.handoff_id,
        ...hopFields(r),
        passed: rubricPassed,
        check_passed: verdict.passed,
        check_verify_status: checkVerifyStatus,
        rubric_grade: grade,
        rubric_overall_disagreement: rubricOverallDisagreement,
        verified: checkVerified,
        ci_parity: parityCheck !== null && checkVerified,
      })
      log(`fix-until-green round ${i + 1}: rubric ${rubricPassed ? 'PASS' : 'FAIL'} on ${r.branch}`)
      if (rubricPassed) {
        return { ok: true, green: true, rounds_used: i + 1, final_branch: r.branch, rounds, check, rubric, ci_parity: parityCheck !== null && checkVerified }
      }
      prevOutput = failedOutput
    } else {
      rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, ...hopFields(r), passed: true, check_passed: verdict.passed, check_verify_status: checkVerifyStatus, verified: checkVerified, ci_parity: parityCheck !== null && checkVerified })
      return { ok: true, green: true, rounds_used: i + 1, final_branch: r.branch, rounds, check, ci_parity: parityCheck !== null && checkVerified }
    }
  } else {
    rounds.push({ round: i + 1, agent: agentForRound, branch: r.branch, handoff_id: r.handoff_id, ...hopFields(r), passed: false, check_verify_status: 'skipped', ci_parity: false })
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
  ci_parity: false,
}
