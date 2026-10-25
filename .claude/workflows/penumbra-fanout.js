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
//   agentType?: 'penumbra:penumbra-fanout-proxy' (default) | 'inherit' (explicit Bash-capable opt-in)
// }

// 240s per slice stays under the workflow runtime's no-progress watchdog while
// cutting poll turns ~2.7x; the tool itself accepts unbounded timeout_ms.
const CHAIN_WAIT_SLICE_MS = 240000
const DISPATCHER_AGENT_TYPE = 'penumbra:penumbra-fanout-proxy'

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
    throw new Error(
      'penumbra-fanout: args was a string but not valid JSON: ' + String(args).slice(0, 200),
    )
  }
}

validateSpec({
  workflowName: 'penumbra-fanout',
  input: input || {},
  topLevelAllowedKeys: ['tasks', 'defaults', 'agentType', 'dispatcherModel', 'repo'],
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
    'response_mode',
    'project_id',
    'caller_cwd',
    'isolated_install',
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
    'response_mode',
    'project_id',
    'caller_cwd',
    'isolated_install',
  ],
  taskRequiredKeys: ['message'],
})

const tasks = input && input.tasks
if (!Array.isArray(tasks) || !tasks.length) {
  log('penumbra-fanout: no tasks. Pass args.tasks = [{ initial_agent, task_class, task_type, message, ... }] (must be an array).')
  return { ok: false, error: 'no_tasks', total: 0, completed: 0, failed: 0, results: [] }
}

const defaults = (input && input.defaults) || {}
if (input.agentType !== undefined && (typeof input.agentType !== 'string' || !input.agentType.trim())) {
  throw new Error('penumbra-fanout: agentType must be a non-empty string')
}
const agentType = input.agentType ?? DISPATCHER_AGENT_TYPE
if (agentType === 'inherit') {
  log("WARNING: agentType:'inherit' uses a generic proxy that can run Bash; prefer the dedicated fanout proxy.")
}
// The proxy is pure glue (dispatch + poll + return) — the real work runs on the
// penumbra fleet agent, not here. Pin it to a cheap model so it doesn't inherit
// the (expensive) session model. Override via args.dispatcherModel; 'inherit' to follow the session.
const dispatcherModel = (input && input.dispatcherModel) || 'sonnet'
// Workflow script sandboxes have no process object, so repo scope must come
// from the parsed args.repo value rather than process.env or process.cwd().
const REPO = input && input.repo

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
  required: ['ok', 'status', 'label', 'index'],
  properties: {
    ok: {
      type: 'boolean',
      description:
        'true only when the chain reached a completed terminal state AND reliability_trustworthy === true — a missing audit is NOT trustworthy (fail-closed). When latest_handoff_id differs from root_handoff_id, ok also requires latest_reliability_trustworthy === true',
    },
    status: { type: 'string', description: 'completed | failed | timeout | error | proxy_error | no_dispatch' },
    error_code: { type: 'string', description: 'proxy_error cause: not_found | denied | other' },
    label: { type: 'string', description: 'the task label echoed verbatim, binding this result to its fan-out slot' },
    index: { type: 'integer', description: 'zero-based position of this task in the fan-out, echoed verbatim' },
    reliability_status: {
      type: 'string',
      description:
        'report.status copied verbatim from the nested report object of mcp__penumbra__dispatch_audit on the root handoff',
    },
    reliability_trustworthy: {
      type: 'boolean',
      description:
        'report.trustworthy copied verbatim from dispatch_audit; ok=true requires reliability_trustworthy === true — false or missing both fail closed',
    },
    reliability_action: {
      type: 'string',
      description: 'report.recommended_action copied verbatim from the nested report object of dispatch_audit',
    },
    latest_reliability_status: {
      type: 'string',
      description:
        'report.status copied verbatim from the nested report object of mcp__penumbra__dispatch_audit on latest_handoff_id',
    },
    latest_reliability_trustworthy: {
      type: 'boolean',
      description:
        'report.trustworthy copied verbatim from the nested report object of mcp__penumbra__dispatch_audit on latest_handoff_id',
    },
    latest_reliability_action: {
      type: 'string',
      description:
        'report.recommended_action copied verbatim from the nested report object of mcp__penumbra__dispatch_audit on latest_handoff_id',
    },
    initial_agent: { type: 'string', description: 'the role or seat as dispatched (roles resolve daemon-side via the router)' },
    conversation_id: { type: 'string' },
    handoff_id: { type: 'string', description: 'root handoff_id returned by chain_start' },
    root_handoff_id: { type: 'string', description: 'handoff_id returned by chain_start for the dispatched root hop' },
    latest_handoff_id: { type: 'string', description: 'last_handoff_id from the terminal chain_wait result' },
    hop_count: { type: 'integer', description: 'number of agent-handoff hops found in the conversation' },
    extra_hops: { type: 'integer', description: 'hop_count - 1, with a minimum of 0' },
    retry_prompt_count: { type: 'integer', description: 'number of silent-failure retry user-prompt events in the conversation' },
    hops_incomplete: { type: 'boolean', description: 'true when retry prompts outnumber enumerable retry handoff rows' },
    hops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          handoff_id: { type: 'string' },
          status: { type: 'string' },
          branch: { type: ['string', 'null'] },
          to_agent: { type: 'string' },
          branch_base: { type: ['string', 'null'] },
          parent_handoff_id: { type: ['string', 'null'] },
          is_retry: { type: 'boolean' },
          created_ts: { type: 'string' },
        },
      },
    },
    branch: { type: 'string', description: 'root handoff branch_name if a worktree branch was created' },
    branch_base: { type: ['string', 'null'], description: 'root handoff branch_base from handoff_get' },
    parent_handoff_id: { type: ['string', 'null'], description: 'root handoff parent_handoff_id from handoff_get' },
    response: { type: 'string', maxLength: 6000, description: 'final worker response text (may be truncated)' },
    check_line: { type: 'string', maxLength: 300, description: 'first non-empty worker response line for lean result modes' },
    failure_tail: { type: 'string', maxLength: 4500, description: 'tail of worker response when a lean check line reports failure' },
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
    max_hops: t.max_hops ?? defaults.max_hops ?? 8,
    timeout_ms: t.timeout_ms ?? defaults.timeout_ms ?? 7200000,
    response_mode: t.response_mode || defaults.response_mode || 'full',
    message: t.message,
  }
  // chain_start rejects non-positive/non-integer max_hops and timeout_ms only
  // after the dispatch spends — reject them here while the spec is still cheap.
  for (const key of ['max_hops', 'timeout_ms']) {
    const value = spec[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(
        `penumbra-fanout: resolved ${key} must be a positive integer; got ${JSON.stringify(value)}`,
      )
    }
  }
  const taskName = t.task_name || t.label || t.name || t.title || defaults.task_name
  if (taskName) spec.task_name = taskName
  const branchType = t.branch_type || defaults.branch_type
  if (branchType) spec.branch_type = branchType
  // Optional: base the worktree on a prior agent branch (enables iterative loops
  // like fix-until-green that build on the previous round's branch).
  const branchBase = t.branch_base || defaults.branch_base
  if (branchBase) spec.branch_base = branchBase
  // isolated_install carries FALSE as its load-bearing value: the daemon resolves an
  // omitted key to true whenever PENUMBRA_ISOLATED_INSTALL_AUTO is set (it is set to 1
  // in both live plists), which forces a bun install and dies on a non-JS repo.
  // ?? not ||, and omit-when-undefined so existing dispatches keep the daemon default.
  const isolatedInstall = t.isolated_install ?? defaults.isolated_install
  if (typeof isolatedInstall === 'boolean') spec.isolated_install = isolatedInstall
  // The daemon launchd plist enables the explicit project gate, so dispatches
  // must carry project_id or a caller_cwd the MCP layer can resolve.
  const projectId = t.project_id ?? defaults.project_id
  if (typeof projectId === 'string' && projectId.trim()) {
    spec.project_id = projectId
  } else {
    const callerCwd = t.caller_cwd ?? defaults.caller_cwd ?? REPO
    const normalizedCallerCwd = typeof callerCwd === 'string' ? callerCwd.trim() : ''
    if (normalizedCallerCwd.startsWith('/')) {
      spec.caller_cwd = normalizedCallerCwd
    }
  }
  if (!spec.project_id && !spec.caller_cwd) {
    throw new Error(
      'penumbra-fanout: no project scope resolved - pass args.defaults.project_id, a per-task project_id, or args.repo/caller_cwd as an absolute path. caller_cwd must be an absolute path. The daemon rejects scope-less dispatches with HTTP 400 project_id_required when PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID is set.',
    )
  }
  return spec
}

function buildPrompt(t, i) {
  const spec = buildSpec(t)
  const label = t.label ?? t.task_name ?? `task-${i}`
  const maxPolls = Math.min(30, Math.ceil(spec.timeout_ms / CHAIN_WAIT_SLICE_MS))
  const dispatchSpec = { ...spec }
  delete dispatchSpec.message
  return [
    'You are a penumbra dispatch proxy. Broker exactly ONE penumbra chain dispatch and report its outcome.',
    'Do NOT implement the task yourself, edit files, or land branches — you only dispatch one chain and report the result.',
    'CRITICAL: pass the Task message section INLINE as the mcp__penumbra__chain_start `message` argument. Do NOT stage it to a file, /tmp, a heredoc, or `cat >` — filesystem writes are NOT allowlisted in workflow agents, so they are permission-denied and stall the whole run. You need NO Bash at all; use only the mcp__penumbra__chain_* MCP tools.',
    '',
    'Dispatch spec (message intentionally omitted here):',
    '```dispatch',
    JSON.stringify(dispatchSpec, null, 2),
    '```',
    '',
    '## Task message (pass VERBATIM as chain_start message argument, do not restate elsewhere)',
    spec.message,
    '',
    'Protocol:',
    '1. Pass initial_agent verbatim to chain_start. A role name ("executor", "reviewer", "planner") is the DEFAULT: the daemon model task router resolves the seat (routing_resolution_reason=role_route). A concrete seat id is a deliberate pin — pass it verbatim, never substitute it. If initial_agent is the literal "AUTO" (legacy), use "executor". Do NOT call agent_recommend to pre-pick a seat; it is forensic only.',
    '2. Call mcp__penumbra__chain_start({ initial_agent, message, task_class, task_type, trust_mode, use_worktree, max_hops, task_name, branch_type, project_id, caller_cwd, branch_base, isolated_install }) — include task_name, branch_type, project_id, caller_cwd, branch_base, and isolated_install only when present in the spec. Pass isolated_install and use_worktree EXACTLY as they appear in the spec, INCLUDING when either is false — false is load-bearing for both (isolated_install:false selects the symlink_mirror worktree path for non-JS repos and is the only override of the daemon\'s PENUMBRA_ISOLATED_INSTALL_AUTO default; use_worktree:false keeps the worker in the checkout instead of spawning a worktree); never omit either key for being falsy. Capture conversation_id, handoff_id, and provisional branch_name from the result. Store the chain_start handoff_id as root_handoff_id; handoff_id in your output keeps this same ROOT-hop meaning.',
    `3. Poll with bounded waits so you never stall: repeatedly call mcp__penumbra__chain_wait({ conversation_id, timeout_ms: ${CHAIN_WAIT_SLICE_MS} }) — each returns within ~240s (under the workflow runtime no-progress watchdog), reporting terminal-or-still-running — until status is terminal (completed/failed), for at most ${maxPolls} iterations. Do NOT issue a single long blocking wait. After each non-terminal wait after more than 8 slices, call mcp__penumbra__chain_status({ handoff_id: root_handoff_id }). chain_status may END polling early ONLY when its top-level handoff status is terminal (completed/failed/rejected/expired); then stop polling and use that terminal result. NEVER abandon or cancel on its reliability.recommended_action or reliability.status fields — they are advisory, non_terminal_stale included; a healthy lane routinely logs no dispatch_events for long stretches (worker heartbeats carry no handoff_id, so they never counted), and dead workers are already force-failed by the daemon's own stale-handoff sweeper and watchdog. If the budget is exhausted without a terminal state, stop with status "timeout" and call mcp__penumbra__chain_cancel({ handoff_id: root_handoff_id }) before returning ok=false. Do not cancel a terminal chain. Report a cancellation failure in error_summary and still return the timeout result; never continue polling or redispatch. Capture latest_handoff_id from the terminal chain_wait last_handoff_id when available. After terminal, enumerate the conversation hop id set as the UNION of: (a) root_handoff_id from chain_start; (b) latest_handoff_id from the terminal chain_wait last_handoff_id; (c) event_id of every event returned by mcp__penumbra__chain_get_messages({ conversation_id, types: ["agent-handoff"] }) where event_type === "agent-handoff"; and (d) payload.handoff_id of every event returned by mcp__penumbra__chain_get_messages({ conversation_id, types: ["agent-response"] }) where event_type === "agent-response". chain_get_messages returns JSON with events[]; each event object has event_id, ts, event_type, source, source_detail, user_id, and payload fields. Agent-response payloads carry handoff_id when available. Also call mcp__penumbra__chain_get_messages({ conversation_id, types: ["user-prompt"] }) and count user-prompt events whose payload.prompt starts with "[silent-failure-retry]"; store that integer as retry_prompt_count. For EVERY hop id in the union, call mcp__penumbra__handoff_get({ handoff_id, compact: false }); the tool returns JSON with a handoff object. Build hops[] from the handoff row fields: handoff_id, status, branch from branch_name, to_agent, branch_base, parent_handoff_id, created_ts from ts, and is_retry true only when the handoff row message starts with "[silent-failure-retry]". Sort hops by created_ts. Set hops_incomplete=true when retry_prompt_count is greater than the number of hops with is_retry true, because a retry that produced no response and is not the latest row cannot be enumerated. Take branch from the ROOT handoff row branch_name; fallback to the terminal chain_wait branch_name only when the root row has no branch_name, then fallback to the chain_start provisional branch_name. Fill top-level branch_base and parent_handoff_id from the ROOT handoff row.`,
    '4. Response handling depends on spec.response_mode. For "full" (the default), call mcp__penumbra__chain_get_response({ conversation_id, handoff_id: root_handoff_id, which: "final" }) and return the worker response in response. For "first_line", call mcp__penumbra__chain_get_response({ conversation_id, handoff_id: root_handoff_id, which: "final" }) only on a completed terminal state, return only the first non-empty line as check_line, and if that line signals failure include only the last 4000 chars as failure_tail. For "none", skip chain_get_response entirely; the terminal chain_wait payload plus root chain_status payload carry status, branch_name, and latest_handoff_id.',
    '5. Once the root hop is terminal, call mcp__penumbra__dispatch_audit({ handoff_id: root_handoff_id }). Its payload is NESTED under a `report` key — copy report.status, report.trustworthy, and report.recommended_action VERBATIM into reliability_status, reliability_trustworthy, and reliability_action. report.status is the audit verdict (values like "complete"); it is distinct from report.evidence.handoff_status, which is the raw handoff row state — do not copy that. The reliability block is served ONLY by dispatch_audit — handoff_get omits it, so do not substitute a handoff_get read. If the audit call fails or returns no report object, leave all three reliability_* fields unset: a missing audit is NOT trustworthy. When latest_handoff_id is set and differs from root_handoff_id, ALSO call mcp__penumbra__dispatch_audit({ handoff_id: latest_handoff_id }) and copy its report.status, report.trustworthy, and report.recommended_action VERBATIM into latest_reliability_status, latest_reliability_trustworthy, and latest_reliability_action. When latest_handoff_id equals root_handoff_id, copy the three root values into the latest_* fields. If the latest audit fails or returns no report object, leave the latest_* fields unset: a missing latest audit is NOT trustworthy.',
    `6. Return StructuredOutput per schema. ok=true only when the ROOT hop reached a completed terminal state AND reliability_trustworthy === true — a missing audit is NOT trustworthy, so absent reliability_* fields mean ok=false with error_summary "reliability_unverified" (use "reliability_untrustworthy" when the audit reports trustworthy === false). When latest_handoff_id differs from root_handoff_id, ok=true additionally requires latest_reliability_trustworthy === true: set error_summary to "latest_reliability_unverified" when the latest audit is absent and "latest_reliability_untrustworthy" when it is false. Otherwise ok=false with status and error_summary naming the cause. Echo the task label "${label}" and index ${i} VERBATIM into label and index. Fill conversation_id with the conversation_id returned by chain_start, handoff_id and root_handoff_id with root_handoff_id, latest_handoff_id with the terminal chain_wait last_handoff_id, hop_count with hops.length, extra_hops with max(hop_count - 1, 0), retry_prompt_count with the retry user-prompt count, hops_incomplete as defined above, hops with every enumerable conversation hop, branch with the ROOT hop branch as defined above, and branch_base/parent_handoff_id from the ROOT handoff row. Do not retry.`,
  ].join('\n')
}

phase('Dispatch')

const dispatchTasks = tasks.map((t, i) => ({ t, i, prompt: buildPrompt(t, i) }))

const results = await parallel(
  dispatchTasks.map(({ t, i, prompt }) => async () => {
    try {
      return await agent(prompt, {
        label: t.label || `dispatch:${t.initial_agent || defaults.initial_agent || 'executor'}#${i}`,
        phase: 'Dispatch',
        schema: DISPATCH_RESULT,
        effort: 'low',
        ...(dispatcherModel && dispatcherModel !== 'inherit' ? { model: dispatcherModel } : {}),
        ...(agentType !== 'inherit' ? { agentType } : {}),
      })
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 300)
      const errorCode = /agent[ _-]?type[\s\S]*not[ _-]?found|unknown agent|no such agent/i.test(message) ? 'not_found'
        : /denied|permission|not allowed/i.test(message) ? 'denied' : 'other'
      return { ok: false, status: 'proxy_error', error_code: errorCode,
        label: t.label ?? t.task_name ?? `task-${i}`, index: i, error_summary: `proxy_error: ${message}` }
    }
  }),
)

// Index-preserving: results[i] answers tasks[i] even when the proxy call
// dropped, so downstream single-task consumers reindexing results[0] stay safe.
// The reliability gate is applied HERE on r.ok — fail-closed: ok requires
// reliability_trustworthy === true, so a missing audit (undefined) is NOT
// trustworthy, and when the chain ended on a distinct latest hop both audits
// must pass: this script still returns the ROOT hop's branch, unlike the
// native port, which selects the latest hop. Consumers read r.ok, so gating
// it in this map closes the hole for every consumer at once, including ones
// that never check the flag.
const clean = results.map((r, i) => {
  const label = tasks[i].label ?? tasks[i].task_name ?? `task-${i}`
  if (!r) return { ok: false, label, index: i, error_summary: 'agent_dropped' }
  if (r.status === 'proxy_error') return { ...r, ok: false, label, index: i }
  if (![r.conversation_id, r.root_handoff_id || r.handoff_id].some((id) => typeof id === 'string' && id.trim())) {
    return { ...r, ok: false, status: 'no_dispatch', proxy_status: r.status, label, index: i, error_summary: r.error_summary ? `no_dispatch: ${r.error_summary}` : 'no_dispatch' }
  }
  const rootId = r.root_handoff_id || r.handoff_id
  const latestRaw = typeof r.latest_handoff_id === 'string' ? r.latest_handoff_id.trim() : ''
  const latestId = latestRaw !== '' ? latestRaw : null
  const latestIsRoot = latestId === null || latestId === rootId
  const rootTrustworthy = r.reliability_trustworthy === true
  const latestTrustworthy = latestIsRoot ? true : r.latest_reliability_trustworthy === true
  const gated = { ...r, ok: r.ok === true && rootTrustworthy && latestTrustworthy, label, index: i }
  if (r.ok === true && !gated.ok && !gated.error_summary) {
    if (!rootTrustworthy) {
      gated.error_summary =
        r.reliability_trustworthy === false ? 'reliability_untrustworthy' : 'reliability_unverified'
    } else if (r.latest_reliability_trustworthy === false) {
      gated.error_summary = 'latest_reliability_untrustworthy'
    } else {
      gated.error_summary = 'latest_reliability_unverified'
    }
  }
  return gated
})
const completed = clean.filter((r) => r.ok === true)
const failed = clean.filter((r) => r.ok !== true)
const dropped = clean.filter((r) => r.error_summary === 'agent_dropped')
const extraHopResults = clean.filter((r) => r && (r.extra_hops > 0 || r.hops_incomplete === true))

for (const r of extraHopResults) {
  const extra = Array.isArray(r.hops) ? r.hops.filter((h) => h && h.handoff_id !== r.root_handoff_id) : []
  const extraSummary = extra.map((h) => `${h.handoff_id}:is_retry=${h.is_retry === true}`).join(', ')
  log(`WARNING: penumbra-fanout extra/incomplete hops ignored for result selection conversation_id=${r.conversation_id} root_handoff_id=${r.root_handoff_id} retry_prompt_count=${r.retry_prompt_count || 0} hops_incomplete=${r.hops_incomplete === true} extra_hops=[${extraSummary}]`)
}

log(
  `penumbra-fanout: ${completed.length}/${tasks.length} completed, ${failed.length} failed` +
    (dropped.length
      ? `, ${dropped.length} dropped (agent skipped/errored): ${dropped.map((d) => d.label).join(', ')}`
      : ''),
)

return {
  ok: failed.length === 0 && clean.length === tasks.length,
  total: tasks.length,
  completed: completed.length,
  failed: failed.length,
  dropped,
  // Branches ready for the orchestrator to review + dispatch_land (this workflow never lands):
  branches: completed.map((r) => r.branch).filter(Boolean),
  extra_hop_results: extraHopResults,
  results: clean,
}
