export const meta = {
  name: 'land-and-close',
  description: 'Codifies the post-dispatch landing tail: lands the branch, verifies it, closes the lane, and resolves the board task sequentially.',
  whenToUse: 'When a fleet task branch is approved and needs to be landed onto main (and optionally close its lane and resolve its board task).',
  phases: [
    { title: 'Land', detail: 'mcp__penumbra__dispatch_land to squash or ff the branch onto main' },
    { title: 'Verify', detail: 'check HEAD matches commit_sha and has non-empty diff' },
    { title: 'Close', detail: 'close the lane (if provided) and resolve the board task (if provided)' },
  ],
}

let a = args
if (typeof a === 'string') {
  try {
    a = JSON.parse(a)
  } catch {
    throw new Error('args was a string but not valid JSON: ' + a)
  }
}

if (!a || !a.handoff_id || !a.commit_message) {
  throw new Error('args must include handoff_id and commit_message')
}

const LAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commit_sha'],
  properties: {
    commit_sha: { type: 'string' },
    error: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['head', 'commit_sha', 'files_changed', 'verified'],
  properties: {
    head: { type: 'string' },
    commit_sha: { type: 'string' },
    files_changed: { type: 'integer' },
    verified: { type: 'boolean' },
  },
}

const CLOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lane_status', 'task_status'],
  properties: {
    lane_status: { type: 'string' },
    task_status: { type: 'string' },
  },
}

// Sanitize everything that gets interpolated into agent prompts — args may
// carry free-form text and must not be able to break the instruction context.
const mode = a.mode === 'ff' ? 'ff' : 'squash'
const gateStatus = ['passed', 'failed', 'skipped', 'review_debt'].includes(a.gate_status)
  ? a.gate_status
  : 'passed'

phase('Land')

const landRes = await agent([
  `STEP 1: Call mcp__penumbra__dispatch_land(handoff_id=${JSON.stringify(String(a.handoff_id))}, mode="${mode}", commit_message=${JSON.stringify(a.commit_message)}, force=${a.force ? 'true' : 'false'}).`,
  `If successful, copy the commit_sha verbatim and set error to an empty string.`,
  `If it fails with an HTTP 409 error or any other error, set error to the verbatim error message and commit_sha to an empty string. DO NOT force retry unless args.force was true.`,
  `Return { commit_sha, error }`
].join('\n'), {
  label: 'land',
  phase: 'Land',
  schema: LAND_SCHEMA,
  model: 'sonnet'
})

if (!landRes || landRes.error || !landRes.commit_sha) {
  return { ok: false, commit_sha: null, head_verified: false, lane_status: null, task_status: null, notes: `Land failed: ${landRes ? landRes.error : 'land agent returned no result'}` }
}

phase('Verify')

// Verify against the HOME checkout — the landed handoff's worktree is torn
// down by dispatch_land, and main only moves in the home repo.
const REPO = '/Volumes/WorkSSD/repos/personal/penumbra'

const verifyRes = await agent([
  `STEP 2: In ${REPO} run 'git rev-parse --short HEAD' and 'git show ${landRes.commit_sha} --stat'.`,
  `Assert that HEAD == ${landRes.commit_sha} (or starts with it) and the stat is non-empty.`,
  `Return { head, commit_sha: "${landRes.commit_sha}", files_changed (number of files changed in stat), verified: (HEAD matches commit_sha and files_changed > 0) }`
].join('\n'), {
  label: 'verify',
  phase: 'Verify',
  schema: VERIFY_SCHEMA,
  model: 'sonnet'
})

if (!verifyRes || !verifyRes.verified) {
  return { ok: false, commit_sha: landRes.commit_sha, head_verified: false, lane_status: null, task_status: null, notes: `Verification failed: ${verifyRes ? `head=${verifyRes.head} expected=${landRes.commit_sha} files_changed=${verifyRes.files_changed}` : 'verify agent returned no result — check the home repo manually.'}` }
}

let closeRes = { lane_status: 'skipped', task_status: 'skipped' }
if (a.lane_id || a.board_task_id) {
  phase('Close')

  closeRes = await agent([
    a.lane_id
      ? `STEP 3: call mcp__penumbra__lane_close with lane_id=${JSON.stringify(String(a.lane_id))}, gate_status="${gateStatus}"${a.reviewer_handoff_id ? `, reviewer_handoff_id=${JSON.stringify(String(a.reviewer_handoff_id))}` : ''}${a.lane_metadata ? `, metadata=${JSON.stringify(a.lane_metadata)}` : ''}.\n  KNOWN BUG TOLERANCE: if the call errors with 'missing implementer_handoff or reviewer_handoff in response', the write almost certainly persisted; if it errors 409 lane_already_closed, the lane was closed earlier (daemon auto-close or a prior call). In BOTH cases verify via mcp__penumbra__lane_ledger_recent and report lane_status from the ledger row; NEVER retry the close.`
      : `STEP 3: no lane to close — set lane_status to 'skipped'.`,
    a.board_task_id
      ? `STEP 4: call mcp__penumbra__task_cancel with task_id=${JSON.stringify(String(a.board_task_id))}, reason=${JSON.stringify(String(a.board_task_reason || `landed as ${landRes.commit_sha}`))}.`
      : `STEP 4: no board task to resolve — set task_status to 'skipped'.`,
    `Return { lane_status, task_status }`
  ].join('\n'), {
    label: 'close',
    phase: 'Close',
    schema: CLOSE_SCHEMA,
    model: 'sonnet'
  })
  if (!closeRes) {
    // The land already happened — surface the partial outcome instead of crashing.
    return { ok: false, commit_sha: landRes.commit_sha, head_verified: true, lane_status: 'unknown', task_status: 'unknown', notes: 'Landed and verified, but the close agent returned no result — close the lane/task manually.' }
  }
}

return {
  ok: true,
  commit_sha: landRes.commit_sha,
  head_verified: verifyRes.verified,
  lane_status: closeRes.lane_status,
  task_status: closeRes.task_status,
  notes: 'Successfully landed, verified, and closed.'
}
