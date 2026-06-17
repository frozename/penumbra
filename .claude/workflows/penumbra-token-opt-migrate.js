export const meta = {
  name: 'penumbra-token-opt-migrate',
  description:
    'Token-opt envelope migration lifecycle: dispatch one tool migration to the penumbra fleet, wait, verify the worktree against a schema, and return structured evidence. Does NOT land — landing stays with maestro.',
  whenToUse:
    'Migrating one MCP tool to the envelope opt-in via the fleet, with fabrication-proof structured verification (no hand-narrated dispatch outcomes).',
  phases: [
    { title: 'Dispatch', detail: 'chain_start one migration to openai-codex-deep-acp' },
    { title: 'Verify', detail: 'inspect the agent worktree: branch, files, typecheck, tests' },
  ],
}

// args: { tool: string, dispatchPrompt: string }
//   tool           - the tool name being migrated (for labels/reporting only)
//   dispatchPrompt - the full chain_start message (the migration contract)
// The script keeps every high-entropy value (handoff_id, branch tip, SHAs) as
// data flowing between phases, and forces the verifier to return a validated
// object — so maestro reports from returned data, never from generated prose.

// args may arrive as a parsed object OR a JSON string depending on the harness;
// normalize to an object.
let parsedArgs = args
if (typeof parsedArgs === 'string') {
  try {
    parsedArgs = JSON.parse(parsedArgs)
  } catch {
    throw new Error('args was a string but not valid JSON: ' + parsedArgs)
  }
}

const tool = (parsedArgs && parsedArgs.tool) || 'unknown-tool'
const dispatchPrompt = parsedArgs && parsedArgs.dispatchPrompt
if (!dispatchPrompt) {
  throw new Error('args.dispatchPrompt is required (the chain_start migration contract)')
}

const REPO = ((typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {})).repo) || (typeof process !== "undefined" ? (process.env.PENUMBRA_REPO || process.cwd()) : ".")

phase('Dispatch')

// Phase 1: dispatch + wait + collect the REAL handoff/branch facts, via a sub-agent
// that has the penumbra MCP tools. It returns ONLY verbatim tool-output values.
const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['handoff_id', 'conversation_id', 'status', 'branch', 'branch_tip', 'commit_count'],
  properties: {
    handoff_id: { type: 'string', description: 'handoff_id copied verbatim from chain_start result' },
    conversation_id: { type: 'string' },
    status: { type: 'string', description: 'terminal status from chain_status (completed/failed/timeout)' },
    reliability_action: { type: 'string', description: 'dispatch reliability recommended_action if present, else "unknown"' },
    branch: { type: 'string', description: 'agent/<handoff_id> branch name, or "MISSING" if absent' },
    branch_tip: { type: 'string', description: 'short SHA of the branch tip from git rev-parse, or "" if missing' },
    commit_count: { type: 'integer', description: 'git rev-list --count main..<branch>' },
    worktree_path: { type: 'string', description: 'absolute path of the agent worktree, or "" if none' },
  },
}

const dispatch = await agent(
  [
    `You are dispatching ONE token-opt migration to the penumbra fleet and reporting back ONLY facts copied verbatim from tool outputs. Do not invent any id or SHA.`,
    ``,
    `STEP 1: call mcp__penumbra__chain_start with:`,
    `  initial_agent: "openai-codex-deep-acp"`,
    `  task_class: "STANDARD"`,
    `  task_type: "implement_small"`,
    `  caller_cwd: "${REPO}"`,
    `  message: <<<the EXACT migration contract below>>>`,
    ``,
    `--- MIGRATION CONTRACT (verbatim message) ---`,
    dispatchPrompt,
    `--- END CONTRACT ---`,
    ``,
    `STEP 2: copy the handoff_id and conversation_id verbatim from the chain_start result.`,
    `STEP 3: poll mcp__penumbra__chain_status with that handoff_id until status is terminal (completed/failed). Use chain_wait on the conversation_id in <=150s increments; never bundle more than one wait per step.`,
    `STEP 4: in the home checkout ${REPO} run (report exact values, no rounding):`,
    `  git rev-parse --verify --quiet agent/<handoff_id>   (branch tip short sha; "MISSING" if absent)`,
    `  git rev-list --count main..agent/<handoff_id>        (commit_count)`,
    `  git worktree list | grep <handoff_id>                (worktree_path)`,
    `Return the structured object. Every value MUST come from a tool result you actually saw this turn.`,
  ].join('\n'),
  { label: `dispatch:${tool}`, phase: 'Dispatch', schema: DISPATCH_SCHEMA, model: 'sonnet' },
)

if (!dispatch || dispatch.branch === 'MISSING' || dispatch.commit_count < 1) {
  return {
    ok: false,
    stage: 'dispatch',
    tool,
    dispatch,
    note: 'dispatch produced no landable branch; nothing to verify or land',
  }
}

phase('Verify')

// Phase 2: independent verifier reads the worktree and runs the gates, returning
// a strict verdict. It must NOT land.
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'typecheck_exit',
    'tests_pass',
    'tests_fail',
    'files_changed',
    'files_outside_mcp',
    'attribution_lines',
    'byte_identical_noenvelope',
    'verdict',
  ],
  properties: {
    typecheck_exit: { type: 'integer', description: 'exit code of: bunx tsc --build packages/mcp/tsconfig.json (run in the worktree)' },
    tests_pass: { type: 'integer', description: 'pass count from bun test ./test/tools/' },
    tests_fail: { type: 'integer', description: 'fail count from bun test ./test/tools/' },
    files_changed: { type: 'integer', description: 'git diff --name-only main..branch | wc -l' },
    files_outside_mcp: { type: 'integer', description: 'count of changed files NOT under packages/mcp/' },
    attribution_lines: { type: 'integer', description: 'count of AI/assistant/co-authored attribution lines in the commit message(s)' },
    byte_identical_noenvelope: { type: 'boolean', description: 'true iff the no-envelope return path is unchanged (the test asserts byte-identical raw JSON)' },
    verdict: { type: 'string', enum: ['pass', 'fail'], description: 'pass iff typecheck_exit==0 AND tests_fail==0 AND files_outside_mcp==0 AND attribution_lines==0 AND byte_identical_noenvelope' },
    notes: { type: 'string' },
  },
}

const verify = await agent(
  [
    `You are independently VERIFYING a token-opt envelope migration for tool "${tool}" on branch ${dispatch.branch} (tip ${dispatch.branch_tip}). DO NOT land, push, edit, or delete anything. Report only measured values.`,
    `The agent worktree is at: ${dispatch.worktree_path || `${REPO}-worktrees/${dispatch.handoff_id}`}`,
    ``,
    `Run and report EXACT values:`,
    `1. In the worktree: bunx tsc --build packages/mcp/tsconfig.json ; capture exit code -> typecheck_exit.`,
    `2. In the worktree's packages/mcp: bun test ./test/tools/ ; parse the "N pass" / "N fail" summary -> tests_pass, tests_fail.`,
    `3. From the home checkout: git diff --name-only main..${dispatch.branch} | wc -l -> files_changed; count files not under packages/mcp/ -> files_outside_mcp.`,
    `4. git log main..${dispatch.branch} --format=%B | count lines matching (co-authored|claude|codex|gpt|assistant|generated with|robot emoji) -> attribution_lines.`,
    `5. Open the new *-envelope.test.ts and confirm it asserts the no-envelope path returns byte-identical JSON.stringify(payload, null, 2) -> byte_identical_noenvelope.`,
    `Then set verdict per the schema rule. Use single-token outputs (wc -l, exit codes) for every count.`,
  ].join('\n'),
  { label: `verify:${tool}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' },
)

return {
  ok: verify && verify.verdict === 'pass',
  tool,
  dispatch,
  verify,
  // Maestro lands manually from these verbatim facts:
  land_hint: {
    handoff_id: dispatch.handoff_id,
    branch: dispatch.branch,
    branch_tip: dispatch.branch_tip,
    command: `dispatch_land(handoff_id="${dispatch.handoff_id}", rebase=true, commit_message="feat(mcp): add envelope opt-in to ${tool} (token-opt)")`,
    reminder: 'Land FIRST; verify HEAD moved + content in main; only THEN any teardown. Never bundle land with branch/worktree deletion.',
  },
}
