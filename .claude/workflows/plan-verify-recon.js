// Stage A of the source-artifact -> dispatch-ready plan pipeline.
//   Workflow({ scriptPath: '.claude/workflows/plan-verify-recon.js',
//              args: { source, clusters: [{key, prompt}], recon: [{key, prompt}],
//                      repo, runDir, verifyModel?, reconModel?, criticModel? } })
//
// Fans out one agent per claim CLUSTER (verification schema) and one per RECON
// dimension (facts/gaps/traps schema) in a single parallel batch, then one
// completeness critic over the merged evidence. Every agent writes its own
// slice to <runDir>; a merge step concatenates the slices on disk. The digest
// returned here is COUNTS ONLY — the orchestrator reads the slice it needs from
// <runDir> rather than carrying 50+ findings in its context.
//
// Fabrication tripwire: the structured returns and the on-disk merge are two
// independent paths to the same number. They must agree or ok is false.
export const meta = {
  name: 'plan-verify-recon',
  description:
    'Verify a source artifact claim-cluster by claim-cluster, map the substrate one recon dimension at a time, then run one completeness critic; write findings.json / recon.json / critic.json to a run directory and return a counts-only digest.',
  whenToUse:
    'Stage A of turning a PR review, spec or design doc into a plan. Pass args.source (the artifact), args.clusters = [{key, prompt}] (one per claim cluster), args.recon = [{key, prompt}] (one per substrate dimension), args.repo and args.runDir (both absolute). Returns counts, not evidence; the evidence lands in args.runDir.',
  phases: [
    { title: 'Evidence', detail: 'one verification agent per claim cluster and one recon agent per substrate dimension, in parallel; each writes its own slice' },
    { title: 'Merge', detail: 'concatenate the slices on disk into findings.json and recon.json, cross-checked against the structured returns' },
    { title: 'Critic', detail: 'one agent hunting what the source missed, what is still unknown, and what must not be parallelized' },
  ],
}

const SEVERITIES = ['critical', 'high', 'medium', 'low']
const VERDICTS = ['CONFIRMED', 'PARTIAL', 'REFUTED', 'STALE_REFS']

let a = args
if (typeof a === 'string') {
  try {
    a = JSON.parse(a)
  } catch {
    throw new Error(
      'plan-verify-recon: args was a string but it is not valid JSON: ' + String(args).slice(0, 200),
    )
  }
}
if (!a || typeof a !== 'object' || Array.isArray(a)) a = {}

const ALLOWED_TOP_LEVEL = [
  'source',
  'clusters',
  'recon',
  'repo',
  'runDir',
  'verifyModel',
  'reconModel',
  'criticModel',
]
for (const key of Object.keys(a)) {
  if (!ALLOWED_TOP_LEVEL.includes(key)) {
    throw new Error(
      'plan-verify-recon: unknown key "' + key + '" at args; allowed keys: ' + ALLOWED_TOP_LEVEL.join(', '),
    )
  }
}

// Scope guards run BEFORE any agent call so a mis-scoped run spends nothing.
// The workflow sandbox has no process object: absolute paths must arrive in
// args, there is deliberately no cwd fallback.
function scopeFailure(reason) {
  return {
    ok: false,
    error: reason,
    run_dir: null,
    findings: null,
    recon: null,
    critic: null,
    artifacts: [],
  }
}
// runDir is interpolated into a shell command below, so it is restricted to a
// shell-inert absolute path rather than escaped after the fact.
const SHELL_INERT_ABS = /^\/[^'"`$\\;|&<>()*?\s]*$/
if (typeof a.repo !== 'string' || !SHELL_INERT_ABS.test(a.repo)) {
  return scopeFailure('no_repo_scope: args.repo must be an absolute path with no shell metacharacters or spaces')
}
if (typeof a.runDir !== 'string' || !SHELL_INERT_ABS.test(a.runDir)) {
  return scopeFailure('no_run_dir: args.runDir must be an absolute path with no shell metacharacters or spaces')
}
const REPO = a.repo
const RUN_DIR = a.runDir.replace(/\/+$/, '')

const source = typeof a.source === 'string' ? a.source.trim() : ''
if (!source) return scopeFailure('no_source: args.source must describe or locate the artifact')

function normalizeUnits(list, label) {
  if (!Array.isArray(list) || list.length === 0) return null
  const out = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    for (const key of Object.keys(item)) {
      if (key !== 'key' && key !== 'prompt') {
        throw new Error(
          'plan-verify-recon: unknown key "' + key + '" at ' + label + '[' + i + ']; allowed keys: key, prompt',
        )
      }
    }
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (!key || !prompt) return null
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
      throw new Error(
        'plan-verify-recon: ' + label + '[' + i + '].key "' + key + '" must be a filename-safe slug',
      )
    }
    out.push({ key, prompt })
  }
  const seen = new Set()
  for (const u of out) {
    if (seen.has(u.key)) throw new Error('plan-verify-recon: duplicate ' + label + ' key "' + u.key + '"')
    seen.add(u.key)
  }
  return out
}

const clusters = normalizeUnits(a.clusters, 'clusters')
if (!clusters) return scopeFailure('no_clusters: args.clusters must be a non-empty array of { key, prompt }')
const reconDims = normalizeUnits(a.recon, 'recon')
if (!reconDims) return scopeFailure('no_recon: args.recon must be a non-empty array of { key, prompt }')

const verifyModel = typeof a.verifyModel === 'string' ? a.verifyModel : 'sonnet'
const reconModel = typeof a.reconModel === 'string' ? a.reconModel : 'sonnet'
const criticModel = typeof a.criticModel === 'string' ? a.criticModel : 'opus'

// ---------------------------------------------------------------- schemas ---
// Reproduced from the run these stages mechanize. conflicts_with is REQUIRED on
// every finding: it is the only field that makes the output sequenceable, and a
// finding without it cannot be placed in a phase order.
const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'claim_id',
    'title',
    'verdict',
    'evidence',
    'already_tested',
    'failure_scenario',
    'severity',
    'fix_sketch',
    'test_sketch',
    'check_command',
    'files_to_touch',
    'package_scope',
    'est_size',
    'conflicts_with',
  ],
  properties: {
    claim_id: { type: 'string', description: 'stable id of the source claim, e.g. "1.1" or "2.MCP-deadline"' },
    title: { type: 'string', description: 'one line naming the defect, not the source sentence' },
    verdict: { type: 'string', enum: VERDICTS },
    evidence: {
      type: 'string',
      description:
        'corrected file:line refs RE-LOCATED this turn plus quoted code. Source line refs are assumed stale; never copy one forward without re-reading the file.',
    },
    already_tested: {
      type: 'string',
      description: 'the existing test that covers this with file:line, or "none found — <what the nearest test does instead>"',
    },
    failure_scenario: { type: 'string', description: 'concrete inputs/state -> wrong output or crash' },
    severity: { type: 'string', enum: SEVERITIES },
    fix_sketch: { type: 'string' },
    test_sketch: { type: 'string', description: 'the assertion that goes RED before the fix and GREEN after' },
    check_command: { type: 'string', description: 'the exact shell command that gates this fix' },
    files_to_touch: { type: 'array', items: { type: 'string' } },
    package_scope: { type: 'string', description: 'the single package that owns this change' },
    est_size: { type: 'string', enum: ['small', 'substantial', 'risky'] },
    conflicts_with: {
      type: 'string',
      description:
        'REQUIRED. Which other claim ids touch the same file/function and therefore must not be dispatched in parallel, and why. "none" only if you checked the other claims in this cluster and there is genuinely no overlap.',
    },
  },
}

const CLUSTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cluster_key', 'findings'],
  properties: {
    cluster_key: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
}

const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'summary', 'facts', 'gaps', 'traps'],
  properties: {
    key: { type: 'string' },
    summary: { type: 'string', description: 'what this dimension looks like today, stated as confirmed-by-execution or inferred' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'evidence'],
        properties: {
          fact: { type: 'string' },
          evidence: { type: 'string', description: 'file:line, command run, or artifact read this turn' },
        },
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['missing', 'where_it_would_live', 'existing_pattern_to_copy', 'est_size'],
        properties: {
          missing: { type: 'string' },
          where_it_would_live: { type: 'string' },
          existing_pattern_to_copy: { type: 'string' },
          est_size: { type: 'string', enum: ['small', 'substantial', 'risky'] },
        },
      },
    },
    traps: {
      type: 'array',
      items: {
        type: 'string',
        description:
          'HIGHEST-VALUE FIELD. Each trap names its BLAST SITE (file:line or command) and its ACTIVATION CONDITION (what an implementer does that trips it). A bare note is not a trap.',
      },
    },
  },
}

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['missed_defects', 'open_questions', 'sequencing_hazards'],
  properties: {
    missed_defects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'evidence', 'failure_scenario', 'severity', 'fix_sketch', 'files_to_touch'],
        properties: {
          title: { type: 'string' },
          evidence: { type: 'string' },
          failure_scenario: { type: 'string' },
          severity: { type: 'string', enum: SEVERITIES },
          fix_sketch: { type: 'string' },
          files_to_touch: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    open_questions: {
      type: 'array',
      items: { type: 'string', description: 'one unknown per entry, naming what would resolve it' },
    },
    sequencing_hazards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['constraint', 'reason'],
        properties: {
          constraint: { type: 'string', description: 'e.g. "1.1 and 1.3 land together" or "6.x after 1.1"' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const WRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'bytes', 'count'],
  properties: {
    path: { type: 'string' },
    bytes: { type: 'integer', description: 'byte size of the written file, from wc -c / stat — never estimated' },
    count: { type: 'integer', description: 'number of top-level entries in the written file' },
  },
}

// ---------------------------------------------------------------- prompts ---
const EVIDENCE_RULES = [
  'Ground rules, non-negotiable:',
  '- RE-LOCATE the code yourself. Treat every file:line in the source artifact as STALE; open the file and correct it.',
  '- Check whether a test ALREADY covers the behaviour before proposing one, and say which test and what it actually asserts.',
  '- A finding is a hypothesis until you have read the code. Never carry a claim forward on the source\'s authority.',
  '- Quote real code. Any evidence string that is not copied from a file you read this turn is a fabrication.',
  '- Report REFUTED as readily as CONFIRMED. A source that is wrong about a claim is the most valuable thing you can return.',
].join('\n')

phase('Evidence')

const clusterThunks = clusters.map((c) => () =>
  agent(
    [
      'You are verifying ONE cluster of claims made by a source artifact against the real code in ' + REPO + '.',
      '',
      '## Source artifact',
      source,
      '',
      '## Your cluster: ' + c.key,
      c.prompt,
      '',
      EVIDENCE_RULES,
      '',
      '## Output',
      'Return one finding per claim in your cluster. cluster_key must be exactly "' + c.key + '".',
      'conflicts_with is REQUIRED on every finding — it is what lets the plan be sequenced. Before writing it, look at the other claims in THIS cluster and name every one that edits the same file or function. "none" is only acceptable after that check.',
      '',
      '## Also write your slice to disk',
      'After you have the findings, write them as a JSON ARRAY of finding objects (no wrapper) to:',
      '    ' + RUN_DIR + '/clusters/' + c.key + '.json',
      'Create the directory first (mkdir -p). The array you write MUST be byte-equivalent in content to the findings you return.',
    ].join('\n'),
    { label: 'verify:' + c.key, phase: 'Evidence', schema: CLUSTER_SCHEMA, agentType: 'Explore', model: verifyModel },
  ).then((body) => ({ key: c.key, body })).catch(() => ({ key: c.key, body: null })),
)

const reconThunks = reconDims.map((r) => () =>
  agent(
    [
      'You are mapping ONE substrate dimension of ' + REPO + ' so that an implementing agent does not trip on it.',
      '',
      '## Context for the work being planned',
      source,
      '',
      '## Your dimension: ' + r.key,
      r.prompt,
      '',
      EVIDENCE_RULES,
      '',
      '## Output',
      'key must be exactly "' + r.key + '".',
      'traps is the highest-value field: each entry names its BLAST SITE (file:line or the exact command) and its ACTIVATION CONDITION (the thing an implementer does that trips it). Prefer a trap you triggered yourself over one you inferred, and say which it is.',
      'gaps entries must name an existing in-repo pattern to copy, not a generic approach.',
      '',
      '## Also write your slice to disk',
      'Write your single recon object as JSON to:',
      '    ' + RUN_DIR + '/recon/' + r.key + '.json',
      'Create the directory first (mkdir -p). It MUST match what you return.',
    ].join('\n'),
    { label: 'recon:' + r.key, phase: 'Evidence', schema: RECON_SCHEMA, agentType: 'Explore', model: reconModel },
  ).then((body) => ({ key: r.key, body })).catch(() => ({ key: r.key, body: null })),
)

const evidence = await parallel(clusterThunks.concat(reconThunks))

const clusterResults = []
const clustersFailed = []
const reconResults = []
const reconFailed = []
for (const e of evidence) {
  if (!e) continue
  const isCluster = clusters.some((c) => c.key === e.key)
  const body = e.body
  const usable = body && typeof body === 'object' && !Array.isArray(body)
  if (isCluster) {
    if (usable && Array.isArray(body.findings)) clusterResults.push(body)
    else clustersFailed.push(e.key)
  } else if (usable && Array.isArray(body.facts)) reconResults.push(body)
  else reconFailed.push(e.key)
}

const findings = []
for (const c of clusterResults) for (const f of c.findings) if (f && typeof f === 'object') findings.push(f)

log(
  'plan-verify-recon: ' + clusterResults.length + '/' + clusters.length + ' clusters, ' +
    reconResults.length + '/' + reconDims.length + ' recon dimensions, ' + findings.length + ' findings',
)

// conflicts_with is enforced here, not merely requested. A findings set with a
// blank conflicts_with cannot be sequenced, so the run is not ok.
const missingConflicts = findings
  .filter((f) => typeof f.conflicts_with !== 'string' || f.conflicts_with.trim() === '')
  .map((f) => String(f.claim_id))

function tally(list, field, keys) {
  const out = {}
  for (const k of keys) out[k] = 0
  out.unknown = 0
  for (const item of list) {
    const v = String(item && item[field])
    if (Object.hasOwn(out, v) && v !== 'unknown') out[v] += 1
    else out.unknown += 1
  }
  return out
}

phase('Merge')

// The merge is a fixed one-liner, not a judgement call: the agent runs it and
// reports what the filesystem says. Its count must equal the count derived from
// the structured returns above, or one of the two paths lied.
function mergeCommand(dir, outFile, wrap) {
  return (
    "cd '" + RUN_DIR + "' && bun -e '" +
    'const fs=require("fs");const d="' + dir + '";const out=[];' +
    'if(fs.existsSync(d)){for(const f of fs.readdirSync(d).filter(x=>x.endsWith(".json")).sort()){' +
    'const j=JSON.parse(fs.readFileSync(d+"/"+f,"utf8"));' +
    (wrap === 'array' ? 'for(const x of (Array.isArray(j)?j:(j.findings||[])))out.push(x);' : 'out.push(Array.isArray(j)?j[0]:j);') +
    '}}' +
    'fs.writeFileSync("' + outFile + '",JSON.stringify(out,null,2)+"\\n");' +
    'console.log("COUNT="+out.length+" BYTES="+fs.statSync("' + outFile + '").size)' +
    "'"
  )
}

function writeAgent(label, command, expectPath) {
  return agent(
    [
      'Run exactly this command and nothing else, then report what it printed:',
      '',
      '    ' + command,
      '',
      'Report the real values: count and bytes come from the command output, never from an estimate.',
      'Do NOT pipe the command into head or tail before reading its status — the exit code you would read is the pipe tail\'s, not the command\'s.',
      'path must be ' + expectPath + '.',
    ].join('\n'),
    { label, phase: 'Merge', schema: WRITE_SCHEMA, model: 'sonnet' },
  ).catch(() => null)
}

const [findingsWrite, reconWrite] = await parallel([
  () => writeAgent('merge:findings', mergeCommand('clusters', 'findings.json', 'array'), RUN_DIR + '/findings.json'),
  () => writeAgent('merge:recon', mergeCommand('recon', 'recon.json', 'object'), RUN_DIR + '/recon.json'),
])

phase('Critic')

// The critic gets a COMPACT projection, not the full evidence: enough to see the
// shape of what was checked and therefore what was not.
const findingsDigestText = findings
  .map((f) =>
    '- [' + f.claim_id + '] ' + f.verdict + '/' + f.severity + ' — ' + f.title +
      '\n  files: ' + (Array.isArray(f.files_to_touch) ? f.files_to_touch.join(', ') : '') +
      '\n  conflicts_with: ' + String(f.conflicts_with || '').slice(0, 300),
  )
  .join('\n')

const reconDigestText = reconResults
  .map((r) => '### ' + r.key + '\n' + String(r.summary || '').slice(0, 1200) + '\ntraps:\n' + (r.traps || []).map((t) => '- ' + t).join('\n'))
  .join('\n\n')

const critic = await agent(
  [
    'You are the completeness critic for a verification pass over ' + REPO + '. You are NOT re-verifying what was already checked.',
    '',
    '## The source artifact that was verified',
    source,
    '',
    '## What the verification pass found (compact)',
    findingsDigestText || '(no findings returned)',
    '',
    '## Substrate recon (summaries + traps)',
    reconDigestText || '(no recon returned)',
    '',
    '## Your three jobs',
    '1. MISSED DEFECTS. In the areas the source artifact covered, what did it miss that is the SAME FAILURE CLASS as something it caught? Open the files yourself and prove each one; a missed defect without a read file:line is not a finding.',
    '2. OPEN QUESTIONS. What is still genuinely unknown, and what single command or file read would resolve it? One question per array entry.',
    '3. SEQUENCING HAZARDS. Which findings MUST NOT be dispatched in parallel or must land together? Look specifically for: (a) same-file serialization; (b) writer-before-reader — a reader fix has no true RED until the writer emits; (c) arm-with-unblock — turning on a gate or cap without its release path converts dead code into starvation; (d) observability-before-expansion.',
    '',
    'Then write your result as JSON to ' + RUN_DIR + '/critic.json (mkdir -p the directory first). It must match what you return.',
  ].join('\n'),
  { label: 'critic', phase: 'Critic', schema: CRITIC_SCHEMA, model: criticModel },
).catch(() => null)

// ----------------------------------------------------------------- digest ---
function artifact(name, write, expectedCount) {
  const path = RUN_DIR + '/' + name
  if (!write || typeof write !== 'object') {
    return { name, path, expected_count: expectedCount, written_count: null, bytes: null, verified: false }
  }
  const written = typeof write.count === 'number' ? write.count : null
  return {
    name,
    path,
    expected_count: expectedCount,
    written_count: written,
    bytes: typeof write.bytes === 'number' ? write.bytes : null,
    verified:
      written === expectedCount &&
      typeof write.bytes === 'number' &&
      write.bytes > 0 &&
      write.path === path,
  }
}

const criticCounts = critic && typeof critic === 'object'
  ? {
      missed_defects: Array.isArray(critic.missed_defects) ? critic.missed_defects.length : 0,
      by_severity: tally(Array.isArray(critic.missed_defects) ? critic.missed_defects : [], 'severity', SEVERITIES),
      open_questions: Array.isArray(critic.open_questions) ? critic.open_questions.length : 0,
      sequencing_hazards: Array.isArray(critic.sequencing_hazards) ? critic.sequencing_hazards.length : 0,
    }
  : null

const artifacts = [
  artifact('findings.json', findingsWrite, findings.length),
  artifact('recon.json', reconWrite, reconResults.length),
]

const notes = []
if (clustersFailed.length) notes.push('clusters returned nothing: ' + clustersFailed.join(', '))
if (reconFailed.length) notes.push('recon dimensions returned nothing: ' + reconFailed.join(', '))
if (missingConflicts.length) {
  notes.push('conflicts_with missing or blank on claim ids: ' + missingConflicts.join(', ') + ' — these cannot be sequenced')
}
for (const art of artifacts) {
  if (!art.verified) {
    notes.push(
      art.name + ' write unverified: structured returns say ' + art.expected_count +
        ', the file says ' + String(art.written_count) + ' — do not plan from this run',
    )
  }
}
if (!criticCounts) notes.push('critic returned nothing; sequencing hazards are unknown for this run')

const ok =
  clustersFailed.length === 0 &&
  reconFailed.length === 0 &&
  findings.length > 0 &&
  missingConflicts.length === 0 &&
  artifacts.every((art) => art.verified) &&
  !!criticCounts

return {
  ok,
  run_dir: RUN_DIR,
  repo: REPO,
  clusters: { requested: clusters.length, returned: clusterResults.length, failed: clustersFailed },
  recon: { requested: reconDims.length, returned: reconResults.length, failed: reconFailed },
  findings: {
    total: findings.length,
    by_verdict: tally(findings, 'verdict', VERDICTS),
    by_severity: tally(findings, 'severity', SEVERITIES),
    by_est_size: tally(findings, 'est_size', ['small', 'substantial', 'risky']),
    missing_conflicts_with: missingConflicts,
    // ids only: the orchestrator reads the evidence from run_dir, not from here.
    actionable_claim_ids: findings
      .filter((f) => f.verdict !== 'REFUTED')
      .map((f) => String(f.claim_id)),
    high_severity_claim_ids: findings
      .filter((f) => f.severity === 'critical' || f.severity === 'high')
      .map((f) => String(f.claim_id)),
    refuted_claim_ids: findings.filter((f) => f.verdict === 'REFUTED').map((f) => String(f.claim_id)),
  },
  recon_keys: reconResults.map((r) => r.key),
  trap_counts: reconResults.map((r) => ({ key: r.key, traps: (r.traps || []).length, gaps: (r.gaps || []).length })),
  critic: criticCounts,
  artifacts: artifacts.concat([
    {
      name: 'critic.json',
      path: RUN_DIR + '/critic.json',
      expected_count: null,
      written_count: null,
      bytes: null,
      // The critic writes this file in its own turn, so there is no independent
      // byte receipt to check it against. Read it before relying on it.
      verified: false,
      note: 'written in-turn by the critic; no independent receipt',
    },
  ]),
  notes,
  next: ok
    ? 'Triage by hand: personally re-verify the high_severity_claim_ids against live state, then derive phase order from conflicts_with + critic.sequencing_hazards before running plan-author-audit.'
    : 'Do not author a plan from this run until the notes above are resolved.',
}
