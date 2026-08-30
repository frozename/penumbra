export const meta = {
  name: 'penumbra-token-opt-batch',
  description:
    'Batch token-opt envelope migrations: fan out dispatch+verify across N tools in PARALLEL (full width for ultracode), then land each verified migration SEQUENTIALLY (the only git-contention step). Fabrication-proof: every cross-phase value is schema-validated data, landing runs in-workflow (no hand-narrated outcomes).',
  whenToUse:
    'Migrating MULTIPLE MCP tools to the envelope opt-in at once. Parallelizes the expensive dispatch/verify; serializes only the land to avoid racing git writes on main.',
  phases: [
    { title: 'DispatchVerify', detail: 'parallel: chain_start + schema-verify each tool' },
    { title: 'Land', detail: 'sequential: dispatch_land + verify-landed + teardown per passed tool' },
  ],
}

// args (JSON string or object): { migrations: [{ tool, dispatchPrompt }], push?: boolean }
//   migrations  - one entry per tool; dispatchPrompt is the verbatim chain_start contract
//   push        - default false. When false, the workflow lands+commits to LOCAL main only
//                 and returns a summary; maestro does ONE `git push` after review (single
//                 outward action). When true, the final land agent also pushes.
let a = args
if (typeof a === 'string') {
  try {
    a = JSON.parse(a)
  } catch {
    throw new Error('args was a string but not valid JSON: ' + a)
  }
}
const migrations = (a && a.migrations) || []
const doPush = !!(a && a.push)
if (!Array.isArray(migrations) || migrations.length === 0) {
  throw new Error('args.migrations must be a non-empty array of { tool, dispatchPrompt }')
}
for (const m of migrations) {
  if (!m || !m.tool || !m.dispatchPrompt) {
    throw new Error('each migration needs { tool, dispatchPrompt }; got: ' + JSON.stringify(m))
  }
}

const REPO = ((typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {})).repo) || (typeof process !== "undefined" ? (process.env.PENUMBRA_REPO || process.cwd()) : ".")

const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['handoff_id', 'status', 'branch', 'branch_tip', 'commit_count'],
  properties: {
    handoff_id: { type: 'string', description: 'verbatim from chain_start result' },
    conversation_id: { type: 'string' },
    status: { type: 'string' },
    reliability_action: { type: 'string' },
    branch: { type: 'string', description: 'handoff branch_name, or "MISSING"' },
    branch_tip: { type: 'string' },
    commit_count: { type: 'integer' },
    worktree_path: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'typecheck_exit',
    'tests_pass',
    'tests_fail',
    'files_outside_mcp',
    'attribution_lines',
    'byte_identical_noenvelope',
    'verdict',
  ],
  properties: {
    typecheck_exit: { type: 'integer' },
    tests_pass: { type: 'integer' },
    tests_fail: { type: 'integer' },
    files_outside_mcp: { type: 'integer' },
    attribution_lines: { type: 'integer' },
    byte_identical_noenvelope: { type: 'boolean' },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description:
        'pass iff typecheck_exit==0 AND tests_fail==0 AND files_outside_mcp==0 AND attribution_lines==0 AND byte_identical_noenvelope',
    },
    notes: { type: 'string' },
  },
}

const LAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'handoff_id', 'landed', 'commit_sha', 'head_after', 'content_in_main', 'cleaned_up'],
  properties: {
    tool: { type: 'string' },
    handoff_id: { type: 'string' },
    landed: { type: 'boolean', description: 'dispatch_land returned ok AND HEAD moved to its commit_sha' },
    commit_sha: { type: 'string', description: 'commit_sha from dispatch_land, verbatim' },
    head_after: { type: 'string', description: 'git rev-parse --short HEAD after landing' },
    content_in_main: { type: 'boolean', description: "branch's own files byte-identical in main" },
    cleaned_up: { type: 'boolean', description: 'worktree removed AND branch deleted' },
    pushed: { type: 'boolean' },
    error: { type: 'string' },
  },
}

phase('DispatchVerify')

// Per-item pipeline: dispatch -> verify. No barrier BETWEEN stages per item, but
// pipeline() returns only after every item finishes both stages (barrier at end),
// which is exactly what we want before the sequential land phase.
const verified = await pipeline(
  migrations,
  // Stage 1: dispatch + wait + collect real branch facts.
  (m) =>
    agent(
      [
        `Dispatch ONE token-opt migration to the penumbra fleet; report ONLY verbatim tool-output values. Never invent an id or SHA.`,
        ``,
        `STEP 1: mcp__penumbra__chain_start with initial_agent="executor", task_class="STANDARD", task_type="implement_small", task_name="${m.tool}", caller_cwd="${REPO}", message = the EXACT contract below.`,
        `--- CONTRACT (verbatim) ---`,
        m.dispatchPrompt,
        `--- END CONTRACT ---`,
        `STEP 2: copy handoff_id + conversation_id + provisional branch_name verbatim from the chain_start result; the chain_start value is provisional because a collision suffix may be applied by the worker.`,
        `STEP 3: poll mcp__penumbra__chain_status until terminal; use chain_wait <=150s per call, one wait per step. Take the FINAL branch_name from the terminal chain_wait or chain_status result; fallback to the chain_start value only if the terminal result lacks it.`,
        `STEP 4: in ${REPO} run: git rev-parse --verify --quiet <branch_name> (branch_tip, "MISSING" if absent); git rev-list --count main..<branch_name> (commit_count); git worktree list | grep <handoff_id> (worktree_path).`,
        `Return the structured object; every value from a tool result you saw this turn.`,
      ].join('\n'),
      { label: `dispatch:${m.tool}`, phase: 'DispatchVerify', schema: DISPATCH_SCHEMA, model: 'sonnet' },
    ).then((dispatch) => ({ tool: m.tool, dispatch })),
  // Stage 2: verify (skip if dispatch produced no branch).
  (prev, m) => {
    const d = prev && prev.dispatch
    if (!d || d.branch === 'MISSING' || d.commit_count < 1) {
      return { tool: m.tool, dispatch: d, verify: null, skipped: 'no-branch' }
    }
    const wt = d.worktree_path || `${REPO}-worktrees/${d.handoff_id}`
    return agent(
      [
        `Independently VERIFY token-opt migration for "${m.tool}" on branch ${d.branch} (tip ${d.branch_tip}). DO NOT land/push/edit/delete. Worktree: ${wt}.`,
        `Measure exact values:`,
        `1. in worktree: bunx tsc --build packages/mcp/tsconfig.json -> typecheck_exit.`,
        `2. in worktree packages/mcp: bun test ./test/tools/ -> tests_pass, tests_fail.`,
        `3. from ${REPO}: count files in main..${d.branch} NOT under packages/mcp/ -> files_outside_mcp.`,
        `4. git log main..${d.branch} --format=%B | count (co-authored|claude|codex|gpt|assistant|generated with|robot) -> attribution_lines.`,
        `5. open the new *-envelope.test.ts; confirm the no-envelope path asserts byte-identical raw JSON (the tool's own JSON.stringify form, compact or pretty) -> byte_identical_noenvelope.`,
        `Set verdict per schema. Use single-token outputs for counts.`,
      ].join('\n'),
      { label: `verify:${m.tool}`, phase: 'DispatchVerify', schema: VERIFY_SCHEMA, model: 'sonnet' },
    ).then((verify) => ({ tool: m.tool, dispatch: d, verify }))
  },
)

const real = verified.filter(Boolean)
const passed = real.filter((r) => r.verify && r.verify.verdict === 'pass')
const failed = real.filter((r) => !r.verify || r.verify.verdict !== 'pass')

log(`dispatch+verify done: ${passed.length} pass, ${failed.length} fail/skip of ${migrations.length}`)

phase('Land')

// SEQUENTIAL land — the ONLY serialized step (concurrent dispatch_land would race
// squash-onto-main). Each runs in its own turn; landing agent reports
// schema-validated facts so nothing is hand-narrated.
const landed = []
for (const r of passed) {
  const d = r.dispatch
  const wt = d.worktree_path || `${REPO}-worktrees/${d.handoff_id}`
  const landResult = await agent(
    [
      `LAND one verified token-opt migration for "${r.tool}". Work in ${REPO}. Report ONLY verbatim values.`,
      `STEP 1: mcp__penumbra__dispatch_land with handoff_id="${d.handoff_id}", mode="squash", commit_message="feat(mcp): add envelope opt-in to ${r.tool} (token-opt)". Copy commit_sha from its result. (dispatch_land has NO 'rebase' param; squash is the default and replays only the agent's own commit even off a stale base.)`,
      `STEP 2: git rev-parse --short HEAD -> head_after. landed = (dispatch_land ok AND head_after is the short form of commit_sha).`,
      `STEP 3: content_in_main: the branch's OWN files (git diff --name-only $(git merge-base main ${d.branch})..${d.branch}) all show empty 'git diff ${d.branch} HEAD -- <those files>'. true/false.`,
      doPush
        ? `STEP 4: git push origin main; set pushed=true iff exit 0.`
        : `STEP 4: do NOT push (pushed=false); maestro pushes once at the end.`,
      `STEP 5: teardown — symlink-safe: rm -f ${wt}/node_modules; find ${wt} -type l -delete; git worktree remove --force ${wt}; git worktree prune; git branch -D ${d.branch}. (The PreToolUse guard allows this once content is in main.) cleaned_up = (worktree gone AND branch gone).`,
      `Return the structured land object; every value from a real tool result this turn. If dispatch_land errors, set landed=false and put the error text in 'error'; do NOT teardown.`,
    ].join('\n'),
    { label: `land:${r.tool}`, phase: 'Land', schema: LAND_SCHEMA, model: 'sonnet' },
  )
  landed.push(landResult)
}

return {
  ok: failed.length === 0 && landed.every((l) => l && l.landed),
  requested: migrations.length,
  passed_verify: passed.map((r) => r.tool),
  failed_verify: failed.map((r) => ({ tool: r.tool, verdict: r.verify ? r.verify.verdict : 'no-verify', skipped: r.skipped })),
  landed,
  pushed: doPush,
  next: doPush
    ? 'all pushed by the workflow'
    : 'maestro: run one `git push origin main` after confirming HEAD, then done',
}
