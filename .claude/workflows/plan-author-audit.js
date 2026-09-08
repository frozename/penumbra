// Stage B of the source-artifact -> dispatch-ready plan pipeline.
//   Workflow({ scriptPath: '.claude/workflows/plan-author-audit.js',
//              args: { phases: [{n, title, brief, claim_ids}], evidenceDir, repo,
//                      runDir, planPath, preamble?, baselines?,
//                      authorModel?, auditModel? } })
//
// Fans out one author agent per phase, assembles the document, applies the
// DETERMINISTIC repairs in code, then audits and validates the assembled result.
//
// The constraint block handed to every author agent is GENERATED at run time by
// `bun scripts/plan-context.ts` — registered seat names, the phase-header regex,
// the real gate commands and the validator rules all drift, and every one of
// them was a hand-typed literal in the run this stage mechanizes. Nothing here
// hardcodes them: if plan-context cannot be run, the fan-out does not happen.
//
// The repairs below are code, not prompts, because each was a real defect in
// that run and an agent is the wrong instrument for a mechanical rewrite:
//   - quote every `id:` (unquoted `id: 11.10` parses as the number 11.1 and
//     silently collides with task 11.1)
//   - re-emit every phase header in the canonical form and check it against the
//     LIVE registrar regex (an ASCII hyphen makes the phase vanish from the
//     registrar with no error anywhere)
//   - regenerate each `Dispatch graph:` line from the yaml meta depends_on edges
//   - downgrade `file_scope: new` to modify-existing where the path exists
//   - strip assembly debris
//   - rewrite absolute "NNNN pass" expectations as "baseline + N"
// The workflow sandbox has no filesystem, so the repairs ship as a generated
// program whose source this script owns byte for byte; the agent only writes it,
// runs it, and returns its report plus a byte receipt that must match.
export const meta = {
  name: 'plan-author-audit',
  description:
    'Author a phased TDD plan one agent per phase against a run-time-generated repo constraint block, assemble it, apply the deterministic validator repairs in code, then audit the assembled document and run the real plan validator.',
  whenToUse:
    'Stage B of turning a source artifact into a dispatch-ready plan, after plan-verify-recon has produced the evidence and a human has done the triage and sequencing. Pass args.phases = [{n, title, brief, claim_ids}], args.evidenceDir, args.repo, args.runDir and args.planPath (all absolute). Registers nothing and dispatches nothing.',
  phases: [
    { title: 'Context', detail: 'shell out to scripts/plan-context.ts for the live seat list, phase-header regex, gate commands and validator rules; fail closed if it does not run' },
    { title: 'Author', detail: 'one agent per plan phase, each given the generated constraint block and its own evidence slice' },
    { title: 'Assemble', detail: 'generated fixer program assembles the phases and applies the deterministic repairs on disk' },
    { title: 'Audit', detail: 'one audit agent over the ASSEMBLED document, plus the real plan validator' },
  ],
}

let a = args
if (typeof a === 'string') {
  try {
    a = JSON.parse(a)
  } catch {
    throw new Error(
      'plan-author-audit: args was a string but it is not valid JSON: ' + String(args).slice(0, 200),
    )
  }
}
if (!a || typeof a !== 'object' || Array.isArray(a)) a = {}

const ALLOWED_TOP_LEVEL = [
  'phases',
  'evidenceDir',
  'repo',
  'runDir',
  'planPath',
  'preamble',
  'baselines',
  'authorModel',
  'auditModel',
]
for (const key of Object.keys(a)) {
  if (!ALLOWED_TOP_LEVEL.includes(key)) {
    throw new Error(
      'plan-author-audit: unknown key "' + key + '" at args; allowed keys: ' + ALLOWED_TOP_LEVEL.join(', '),
    )
  }
}

function scopeFailure(reason) {
  return { ok: false, error: reason, plan_path: null, phases: null, fixes: null, audit: null, validator: null }
}

// Absolute-path fail-closed, before any spend. There is no cwd to fall back on,
// and each of these paths is interpolated into a shell command below, so they
// are restricted to shell-inert forms rather than escaped after the fact.
const SHELL_INERT_ABS = /^\/[^'"`$\\;|&<>()*?\s]*$/
for (const key of ['repo', 'runDir', 'planPath', 'evidenceDir']) {
  if (typeof a[key] !== 'string' || !SHELL_INERT_ABS.test(a[key])) {
    return scopeFailure(
      'no_' + key.toLowerCase() + '_scope: args.' + key + ' must be an absolute path with no shell metacharacters or spaces',
    )
  }
}
const REPO = a.repo.replace(/\/+$/, '') || '/'
const RUN_DIR = a.runDir.replace(/\/+$/, '')
const EVIDENCE_DIR = a.evidenceDir.replace(/\/+$/, '')
const PLAN_PATH = a.planPath

// The plan validator resolves `file_scope: new` against the repo root it finds
// by walking UP from the PLAN path; the repair pass below resolves it against
// args.repo. A plan written outside the repo makes those two different trees and
// the existence check silently tests the wrong one — reproduced: the same
// document validates 0 from inside its own checkout and 2 from /tmp.
if (PLAN_PATH !== REPO && !PLAN_PATH.startsWith(REPO === '/' ? '/' : REPO + '/')) {
  return scopeFailure(
    'plan_path_outside_repo: args.planPath must live under args.repo, or the validator checks file_scope against a different tree than this run corrected against',
  )
}

const rawPhases = Array.isArray(a.phases) ? a.phases : []
if (rawPhases.length === 0) return scopeFailure('no_phases: args.phases must be a non-empty array')

const phaseSpecs = []
const seenPhaseNos = new Set()
for (let i = 0; i < rawPhases.length; i++) {
  const p = rawPhases[i]
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return scopeFailure('bad_phase: args.phases[' + i + '] must be an object { n, title, brief, claim_ids }')
  }
  for (const key of Object.keys(p)) {
    if (!['n', 'title', 'brief', 'claim_ids'].includes(key)) {
      throw new Error(
        'plan-author-audit: unknown key "' + key + '" at phases[' + i + ']; allowed keys: n, title, brief, claim_ids',
      )
    }
  }
  const n = Number(p.n)
  if (!Number.isInteger(n) || n < 1) return scopeFailure('bad_phase: phases[' + i + '].n must be a positive integer')
  if (seenPhaseNos.has(n)) return scopeFailure('bad_phase: duplicate phase number ' + n)
  seenPhaseNos.add(n)
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  if (!title) return scopeFailure('bad_phase: phases[' + i + '].title is required')
  phaseSpecs.push({
    n,
    title,
    brief: typeof p.brief === 'string' ? p.brief : '',
    claim_ids: Array.isArray(p.claim_ids) ? p.claim_ids.map(String) : [],
  })
}
phaseSpecs.sort((x, y) => x.n - y.n)

const authorModel = typeof a.authorModel === 'string' ? a.authorModel : 'opus'
const auditModel = typeof a.auditModel === 'string' ? a.auditModel : 'opus'
const baselines = a.baselines && typeof a.baselines === 'object' && !Array.isArray(a.baselines) ? a.baselines : {}
const preamble = typeof a.preamble === 'string' ? a.preamble : ''

// ---------------------------------------------------------------- schemas ---
const CONTEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'exit_code',
    'command',
    'constraint_markdown',
    'seats',
    'phase_header_regex_source',
    'phase_header_separator',
    'gate_commands',
  ],
  properties: {
    exit_code: { type: 'integer', description: 'the real exit code, read on its own line — never through a pipe into head/tail' },
    command: { type: 'string', description: 'the exact command you ran' },
    constraint_markdown: {
      type: 'string',
      description: 'the generated constraint block, copied VERBATIM from the generator output. Do not summarize, reorder or re-type it.',
    },
    seats: {
      type: 'array',
      items: { type: 'string' },
      description: 'the concrete registered seat names the generator says a plan may pin, verbatim and in generator order',
    },
    phase_header_regex_source: { type: 'string', description: 'the phase-header regex source the generator extracted from the registrar, without the enclosing slashes' },
    phase_header_separator: { type: 'string', description: 'the exact separator string the regex accepts between the phase number and the title, including its surrounding spaces' },
    gate_commands: { type: 'array', items: { type: 'string' }, description: 'the real gate commands, verbatim' },
  },
}

const AUTHOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['phase_no', 'path', 'bytes', 'task_ids', 'seats_used', 'evidence_claim_ids_used'],
  properties: {
    phase_no: { type: 'integer' },
    path: { type: 'string' },
    bytes: { type: 'integer', description: 'byte size of the file you wrote, from wc -c — never estimated' },
    task_ids: { type: 'array', items: { type: 'string' }, description: 'every task id you emitted, in document order' },
    seats_used: { type: 'array', items: { type: 'string' }, description: 'every distinct preferred_agent / fallback_agent value you emitted' },
    evidence_claim_ids_used: { type: 'array', items: { type: 'string' } },
  },
}

const FIXER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fixer_bytes_written', 'exit_code', 'report_json'],
  properties: {
    fixer_bytes_written: { type: 'integer', description: 'wc -c of the fixer file you wrote, before running it' },
    exit_code: { type: 'integer', description: 'the fixer exit code, read on its own line' },
    report_json: { type: 'string', description: 'the fixer stdout, copied verbatim. It is a single JSON object; do not reformat or summarize it.' },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocking', 'advisory', 'fabricated_evidence', 'verdict'],
  properties: {
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'location', 'detail'],
        properties: {
          category: {
            type: 'string',
            enum: [
              'validator_failure',
              'duplicate_id',
              'placeholder',
              'cross_phase_naming',
              'ordering_violation',
              'fabricated_evidence',
              'missing_gate',
              'unquoted_id',
              'seat_not_registered',
            ],
          },
          location: { type: 'string', description: 'plan line number or the task id' },
          detail: { type: 'string' },
        },
      },
    },
    advisory: { type: 'array', items: { type: 'string' } },
    fabricated_evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id', 'claim', 'why_unsupported'],
        properties: {
          task_id: { type: 'string' },
          claim: { type: 'string' },
          why_unsupported: { type: 'string', description: 'what you found when you opened the cited file:line' },
        },
      },
    },
    verdict: { type: 'string', enum: ['dispatch_ready', 'needs_repair'] },
  },
}

const VALIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exit_code', 'command', 'stderr_lines'],
  properties: {
    exit_code: { type: 'integer' },
    command: { type: 'string' },
    stderr_lines: { type: 'array', items: { type: 'string' }, description: 'every validator error line, verbatim; empty on a clean run' },
  },
}

// ---------------------------------------------------------------- context ---
phase('Context')

const context = await agent(
  [
    'Generate the plan-authoring constraint block for ' + REPO + ' from the LIVE repo and daemon.',
    '',
    'Run, from ' + REPO + ':',
    '',
    '    cd ' + REPO + ' && bun scripts/plan-context.ts --json > /tmp/plan-context.out 2> /tmp/plan-context.err',
    '    echo "EXIT=$?"',
    '',
    'Read the exit code on its OWN line as shown. Do not pipe the command into head or tail first — the status you would read is the pipe tail\'s.',
    'If --json is not a supported flag, re-run without it and take the fields from its plain output.',
    '',
    'Then return, copied verbatim from that output and from nowhere else:',
    '- constraint_markdown: the whole generated block, unedited.',
    '- seats: the concrete registered seat names it says a plan may pin.',
    '- phase_header_regex_source and phase_header_separator: what it reports for the registrar phase header.',
    '- gate_commands: the real gate commands it reports.',
    '',
    'Do NOT substitute remembered seat names, a remembered regex or a remembered gate command for anything the generator did not print. If the generator did not run, return its exit code and leave seats empty — an empty seats list stops this pipeline, which is the correct outcome.',
  ].join('\n'),
  { label: 'plan-context', phase: 'Context', schema: CONTEXT_SCHEMA, model: 'sonnet' },
).catch(() => null)

const seats = context && Array.isArray(context.seats) ? context.seats.filter((s) => typeof s === 'string' && s.trim()) : []
if (!context || context.exit_code !== 0 || seats.length === 0) {
  // Fail closed. plan validate itself falls back to a five-name builtin list
  // when the daemon is unreachable, so a plan authored without a live seat list
  // can validate clean today and be unroutable tomorrow.
  return {
    ok: false,
    error: 'plan_context_unavailable: bun scripts/plan-context.ts did not produce a live seat list; refusing to author against remembered constraints',
    plan_path: null,
    context: context ? { exit_code: context.exit_code, command: context.command, seats: seats.length } : null,
    phases: null,
    fixes: null,
    audit: null,
    validator: null,
  }
}

const sep = typeof context.phase_header_separator === 'string' && context.phase_header_separator
  ? context.phase_header_separator
  : ' \u2014 '
const headerRegexSource = typeof context.phase_header_regex_source === 'string' && context.phase_header_regex_source
  ? context.phase_header_regex_source
  : '^## Phase \\d+(?: \u2014 |: )'
const constraintBlock = String(context.constraint_markdown || '')
const gateCommands = Array.isArray(context.gate_commands) ? context.gate_commands.filter((g) => typeof g === 'string') : []

// The generated separator must satisfy the generated regex before a single
// header is written; a mismatch here would put the trap back by construction.
let headerProbeOk = false
try {
  headerProbeOk = new RegExp(headerRegexSource).test('## Phase 1' + sep + 'probe')
} catch {
  headerProbeOk = false
}
if (!headerProbeOk) {
  return {
    ok: false,
    error: 'phase_header_contract_broken: the generated separator ' + JSON.stringify(sep) + ' does not satisfy the generated regex ' + JSON.stringify(headerRegexSource) + '; a phase written this way would vanish from the registrar silently',
    plan_path: null,
    context: { exit_code: context.exit_code, seats: seats.length },
    phases: null,
    fixes: null,
    audit: null,
    validator: null,
  }
}

log('plan-author-audit: constraint block generated — ' + seats.length + ' pinnable seats, ' + gateCommands.length + ' gate commands')

// ----------------------------------------------------------------- author ---
phase('Author')

const FORMAT_CONTRACT = [
  '## Output format contract — the plan parser and the registrar both read this mechanically',
  '',
  'Write ONLY your phase. Do NOT emit the document front matter, the goal, the baseline table or any other phase.',
  'Do NOT wrap your output in a code fence. Do NOT preface it with a sentence about what you produced.',
  'Do NOT emit the `## Phase N` header line yourself — this pipeline emits it, in the exact form the registrar accepts.',
  'Do NOT emit a `Dispatch graph:` line — it is regenerated from your depends_on edges.',
  '',
  'Every task is a `### ` heading followed by a fenced `yaml meta` block:',
  '',
  '    ### Task <phase>.<k>: <imperative title>',
  '',
  '    ```yaml meta',
  '    id: "<phase>.<k>"',
  '    files:',
  '      - <repo-relative path>',
  '    file_scope: new | modify-existing | extend-shared',
  '    depends_on: []',
  '    parallel_with: []',
  '    preferred_agent: <a concrete seat name from the list above>',
  '    fallback_agent: <a different concrete seat name from the list above>',
  '    task_size: small | substantial | risky',
  '    risk_class: paste-ready | schema-aware | bootstrap-touching',
  '    ```',
  '',
  'Hard rules the parser enforces silently — a violation costs you the task, not an error message:',
  '- QUOTE every id and every depends_on / parallel_with entry. Unquoted decimals are read as numbers.',
  '- Task headings are `### `. Never put a `## ` line between a task heading and its yaml block — it erases the heading.',
  '- Close every fenced block. An unclosed one deletes the whole task from the parse with no error.',
  '- depends_on entries name task ids only. parallel_with must be reciprocal: if A lists B, B lists A.',
  '- `file_scope: new` is checked against the disk at validation time. If the path already exists, use modify-existing.',
  '- preferred_agent and fallback_agent must be concrete seat names from the generated list. A role name is rejected.',
  '',
  'Each task body: **Files:** (modify / test), then numbered `- [ ] **Step N:**` items in strict TDD order — write the failing test with its real assertion, implement, then verify with the exact gate command. Quote real code you read; never invent a file:line.',
  'End each task with an `Expected:` line stating the result as a DELTA against the recorded baseline ("baseline + 2 pass / 0 fail"), never as an absolute count.',
].join('\n')

const authorThunks = phaseSpecs.map((p) => () =>
  agent(
    [
      'You are authoring ONE phase of a phased TDD implementation plan for ' + REPO + '.',
      '',
      '## Phase ' + p.n + ': ' + p.title,
      p.brief || '(no brief supplied — derive the scope from your evidence slice)',
      '',
      '## Generated repo constraints — these were read from the live repo and daemon at run time. They override anything you remember.',
      constraintBlock,
      '',
      gateCommands.length ? '## Gate commands, verbatim\n' + gateCommands.map((g) => '    ' + g).join('\n') : '',
      '',
      '## Seats you may pin',
      seats.map((s) => '- ' + s).join('\n'),
      'Use no other name. A seat outside this list either fails validation or fails at run time.',
      '',
      '## Your evidence slice',
      'Read ' + EVIDENCE_DIR + '/findings.json and use ONLY the entries whose claim_id is in this list:',
      p.claim_ids.length ? p.claim_ids.map((c) => '  - ' + c).join('\n') : '  (none — this phase is derived from recon, not from verified claims)',
      'Also read ' + EVIDENCE_DIR + '/recon.json (the traps arrays especially) and ' + EVIDENCE_DIR + '/critic.json (sequencing_hazards).',
      'A finding with verdict REFUTED is a reason NOT to write a task. Say so in the phase prose instead of quietly dropping it.',
      '',
      '## Before you write a single code step',
      'Open the real files named in your evidence and read them. Every file:line you cite must be one you read this turn; the evidence refs may already have moved. A step written against a remembered file shape is the failure mode this contract exists to stop.',
      '',
      FORMAT_CONTRACT,
      '',
      '## Write it to disk',
      'Write your phase body to ' + RUN_DIR + '/phases/phase-' + p.n + '.md (mkdir -p first), then report `wc -c` of that file as bytes.',
      'task_ids, seats_used and evidence_claim_ids_used must be read back off the file you wrote, not from what you intended to write.',
    ].join('\n'),
    { label: 'author:phase-' + p.n, phase: 'Author', schema: AUTHOR_SCHEMA, model: authorModel },
  ).then((body) => ({ n: p.n, body })).catch(() => ({ n: p.n, body: null })),
)

const authored = await parallel(authorThunks)

const phaseReports = []
const phasesFailed = []
const seatViolations = []
for (const r of authored) {
  const body = r && r.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.bytes !== 'number' || body.bytes <= 0) {
    phasesFailed.push(r ? r.n : null)
    continue
  }
  phaseReports.push({ n: r.n, ...body })
  for (const s of Array.isArray(body.seats_used) ? body.seats_used : []) {
    if (!seats.includes(s)) seatViolations.push({ phase: r.n, seat: s })
  }
}
log('plan-author-audit: ' + phaseReports.length + '/' + phaseSpecs.length + ' phases authored')

if (phaseReports.length === 0) {
  return {
    ok: false,
    error: 'no_phase_authored: every author agent failed; nothing to assemble',
    plan_path: null,
    context: { seats: seats.length },
    phases: { requested: phaseSpecs.length, authored: 0, failed: phasesFailed },
    fixes: null,
    audit: null,
    validator: null,
  }
}

// --------------------------------------------------------------- assemble ---
phase('Assemble')

// The fixer is this script's own source, line for line. The agent writes it and
// runs it; the byte receipt below is what proves it wrote what we sent.
const FIXER_LINES = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const R = { fixer_version: "1", plan_path: CFG.planPath, bytes: 0, phases_assembled: 0, missing_phase_files: [],',
  '  phase_headers: [], headers_failing_regex: [], ids_quoted: [], dep_ids_quoted: [], duplicate_ids: [],',
  '  meta_blocks_found: 0, meta_blocks_unclosed: 0, tasks_parsed: 0, heading_clobbered: [], tasks_missing_heading: [],',
  '  graphs_rewritten: [], graph_cycles: [], file_scope_corrected: [], file_scope_suspect: [],',
  '  debris_stripped: [], fences_unwrapped: [], expectations_rewritten: [], expectations_skipped: [], baselines_used: {} };',
  '',
  'const DEBRIS = [',
  '  /^\\s*-{2,}\\s*END OF (?:PHASE|SECTION|OUTPUT|PLAN)\\b.*$/i,',
  '  /^\\s*<\\/?(?:phase|output|plan|document)[^>]*>\\s*$/i,',
  '  /^\\s*\\[?(?:continued|truncated|end of (?:phase|output|plan))\\.?\\]?\\s*$/i,',
  '  /^\\s*(?:Here (?:is|\'s)|Below is|This is) (?:the |my )?(?:complete |full |assembled |final )?(?:phase|plan|section|output|markdown|document)\\b.*$/i,',
  '  /^\\s*I (?:have |\'ve )(?:now )?(?:written|authored|produced|assembled)\\b.*$/i,',
  '  /^\\s*(?:Let me know if|Note: this (?:phase|output))\\b.*$/i,',
  '];',
  '',
  'function unq(v) { const t = String(v).trim(); const m = t.match(/^"(.*)"$|^\'(.*)\'$/); return m ? (m[1] !== undefined ? m[1] : m[2]) : t; }',
  'function inlineArr(v) { const inner = String(v).trim().replace(/^\\[/, "").replace(/\\]$/, "").trim(); if (!inner) return []; return inner.split(",").map((x) => unq(x)).filter((x) => x !== ""); }',
  '',
  'function unwrapFence(lines, phaseNo) {',
  '  let s = 0, e = lines.length - 1;',
  '  while (s < lines.length && lines[s].trim() === "") s++;',
  '  while (e > s && lines[e].trim() === "") e--;',
  '  if (s >= e) return lines;',
  '  if (!/^```(?:markdown|md)?\\s*$/.test(lines[s].trim()) || lines[e].trim() !== "```") return lines;',
  '  let depth = 0;',
  '  for (let i = s + 1; i < e; i++) if (lines[i].trim().startsWith("```")) depth = depth === 0 ? 1 : 0;',
  '  if (depth !== 0) return lines;',
  '  R.fences_unwrapped.push(phaseNo);',
  '  return lines.slice(s + 1, e);',
  '}',
  '',
  'function stripAuthorHeader(lines, phaseNo) {',
  '  const out = [];',
  '  let dropped = false;',
  '  for (const l of lines) {',
  '    if (!dropped && /^##\\s+Phase\\s+\\d+\\b/.test(l)) { dropped = true; continue; }',
  '    if (!dropped && /^\\s*Dispatch graph\\s*:/.test(l)) { dropped = true; continue; }',
  '    out.push(l);',
  '  }',
  '  if (dropped) R.debris_stripped.push({ phase: phaseNo, reason: "author-emitted phase header or dispatch graph", text: "(re-emitted canonically)" });',
  '  return out;',
  '}',
  '',
  'function fenceState(lines) {',
  '  const inFence = new Array(lines.length).fill(false);',
  '  const metaBlocks = [];',
  '  let open = -1, openIsMeta = false;',
  '  for (let i = 0; i < lines.length; i++) {',
  '    const t = lines[i].trim();',
  '    if (t.startsWith("```")) {',
  '      if (open < 0) { open = i; openIsMeta = t === "```yaml meta"; inFence[i] = true; }',
  '      else { if (openIsMeta) metaBlocks.push({ open, close: i }); inFence[i] = true; open = -1; openIsMeta = false; }',
  '      continue;',
  '    }',
  '    if (open >= 0) inFence[i] = true;',
  '  }',
  '  if (open >= 0) { R.meta_blocks_unclosed += openIsMeta ? 1 : 0; for (let i = open; i < lines.length; i++) inFence[i] = true; }',
  '  return { inFence, metaBlocks };',
  '}',
  '',
  'function quoteIds(lines, metaBlocks) {',
  '  for (const b of metaBlocks) {',
  '    let key = null;',
  '    for (let i = b.open + 1; i < b.close; i++) {',
  '      const kv = lines[i].match(/^([a-z_]+):\\s*(.*)$/);',
  '      if (kv) {',
  '        key = kv[1];',
  '        const val = kv[2].trim();',
  '        if (key === "id" && /^[0-9][0-9.]*$/.test(val)) { lines[i] = "id: \\"" + val + "\\""; R.ids_quoted.push(val); }',
  '        else if ((key === "depends_on" || key === "parallel_with") && val.startsWith("[")) {',
  '          const items = inlineArr(val);',
  '          const quoted = items.map((x) => (/^[0-9][0-9.]*$/.test(x) ? (R.dep_ids_quoted.push(x), "\\"" + x + "\\"") : (/^".*"$/.test(x) ? x : "\\"" + x + "\\"")));',
  '          lines[i] = key + ": [" + quoted.join(", ") + "]";',
  '        }',
  '        continue;',
  '      }',
  '      const li = lines[i].match(/^(\\s*-\\s*)(.+?)\\s*$/);',
  '      if (li && (key === "depends_on" || key === "parallel_with")) {',
  '        const v = li[2].trim();',
  '        if (/^[0-9][0-9.]*$/.test(v)) { lines[i] = li[1] + "\\"" + v + "\\""; R.dep_ids_quoted.push(v); }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
  'function parseTasks(lines, metaBlocks) {',
  '  const tasks = [];',
  '  for (const b of metaBlocks) {',
  '    const t = { id: null, files: [], fileScope: null, deps: [], par: [], open: b.open, close: b.close, scopeLine: -1, phase: null, heading: null };',
  '    let key = null;',
  '    for (let i = b.open + 1; i < b.close; i++) {',
  '      const kv = lines[i].match(/^([a-z_]+):\\s*(.*)$/);',
  '      if (kv) {',
  '        key = kv[1];',
  '        const val = kv[2].trim();',
  '        if (key === "id") t.id = unq(val);',
  '        else if (key === "file_scope") { t.fileScope = unq(val); t.scopeLine = i; }',
  '        else if (val.startsWith("[")) { const arr = inlineArr(val); if (key === "files") t.files = arr; else if (key === "depends_on") t.deps = arr; else if (key === "parallel_with") t.par = arr; key = null; }',
  '        continue;',
  '      }',
  '      const li = lines[i].match(/^\\s*-\\s*(.+?)\\s*$/);',
  '      if (li && key) { const v = unq(li[1]); if (key === "files") t.files.push(v); else if (key === "depends_on") t.deps.push(v); else if (key === "parallel_with") t.par.push(v); }',
  '    }',
  '    for (let i = b.open - 1; i >= 0; i--) {',
  '      if (/^###\\s+/.test(lines[i])) { t.heading = lines[i]; break; }',
  '      if (/^##\\s+/.test(lines[i])) { R.heading_clobbered.push({ id: t.id, clobbered_by: lines[i].slice(0, 80) }); break; }',
  '    }',
  '    for (let i = b.open - 1; i >= 0; i--) { const m = lines[i].match(/^##\\s+Phase\\s+(\\d+)\\b/); if (m) { t.phase = Number(m[1]); break; } }',
  '    if (!t.heading) R.tasks_missing_heading.push(t.id);',
  '    tasks.push(t);',
  '  }',
  '  return tasks;',
  '}',
  '',
  'function fixFileScope(lines, tasks) {',
  '  for (const t of tasks) {',
  '    if (t.scopeLine < 0 || t.files.length === 0) continue;',
  '    const existing = t.files.filter((f) => fs.existsSync(path.resolve(CFG.repo, f)));',
  '    if (t.fileScope === "new" && existing.length > 0) {',
  '      lines[t.scopeLine] = "file_scope: modify-existing";',
  '      t.fileScope = "modify-existing";',
  '      R.file_scope_corrected.push({ id: t.id, from: "new", to: "modify-existing", existing_files: existing });',
  '    } else if (t.fileScope !== "new" && existing.length === 0) {',
  '      R.file_scope_suspect.push({ id: t.id, scope: t.fileScope, files: t.files });',
  '    }',
  '  }',
  '}',
  '',
  'function graphFor(tasks) {',
  '  const ids = new Set(tasks.map((t) => t.id));',
  '  const lvl = new Map();',
  '  const state = new Map();',
  '  let cyclic = false;',
  '  function level(id) {',
  '    if (lvl.has(id)) return lvl.get(id);',
  '    if (state.get(id) === 1) { cyclic = true; return 0; }',
  '    state.set(id, 1);',
  '    const t = tasks.find((x) => x.id === id);',
  '    const deps = (t ? t.deps : []).filter((d) => ids.has(d) && d !== id);',
  '    const v = deps.length ? Math.max(...deps.map((d) => level(d) + 1)) : 0;',
  '    state.set(id, 2);',
  '    lvl.set(id, v);',
  '    return v;',
  '  }',
  '  for (const t of tasks) level(t.id);',
  '  if (cyclic) return null;',
  '  const max = Math.max(...tasks.map((t) => lvl.get(t.id)));',
  '  const groups = [];',
  '  for (let L = 0; L <= max; L++) { const g = tasks.filter((t) => lvl.get(t.id) === L).map((t) => t.id); if (g.length) groups.push(g.join(" \\u2225 ")); }',
  '  return groups.join(" \\u2192 ");',
  '}',
  '',
  'function rewriteGraphs(lines, tasks) {',
  '  for (let i = lines.length - 1; i >= 0; i--) {',
  '    const m = lines[i].match(/^##\\s+Phase\\s+(\\d+)\\b/);',
  '    if (!m) continue;',
  '    const n = Number(m[1]);',
  '    const mine = tasks.filter((t) => t.phase === n && t.id);',
  '    if (!mine.length) continue;',
  '    const graph = graphFor(mine);',
  '    if (graph === null) { R.graph_cycles.push(n); continue; }',
  '    const line = "Dispatch graph: " + graph;',
  '    let j = i + 1;',
  '    while (j < lines.length && lines[j].trim() === "") j++;',
  '    if (j < lines.length && /^\\s*Dispatch graph\\s*:/.test(lines[j])) {',
  '      if (lines[j] !== line) R.graphs_rewritten.push({ phase: n, before: lines[j], after: line });',
  '      lines[j] = line;',
  '    } else {',
  '      lines.splice(i + 1, 0, "", line);',
  '      R.graphs_rewritten.push({ phase: n, before: "(absent)", after: line });',
  '    }',
  '  }',
  '}',
  '',
  'function parseBaselines(lines) {',
  '  const out = Object.assign({}, CFG.baselines);',
  '  for (const l of lines) {',
  '    const m = l.match(/^\\|\\s*(?:shard\\s*)?`?([A-Za-z0-9_/.-]+)`?\\s*\\|\\s*([\\d,]+)\\s*pass/);',
  '    if (!m) continue;',
  '    const key = m[1].replace(/^packages\\//, "");',
  '    const n = Number(m[2].replace(/,/g, ""));',
  '    if (Number.isFinite(n) && !Object.hasOwn(out, key)) out[key] = n;',
  '  }',
  '  return out;',
  '}',
  '',
  'function rewriteExpectations(lines, inFence, baselines) {',
  '  const keys = Object.keys(baselines);',
  '  for (let i = 0; i < lines.length; i++) {',
  '    if (inFence[i]) continue;',
  '    const line = lines[i];',
  '    if (!/expected/i.test(line)) continue;',
  '    if (!/\\b\\d{3,}\\s+pass\\b/.test(line)) continue;',
  '    let shard = null;',
  '    const pk = line.match(/packages\\/([A-Za-z0-9_-]+)/);',
  '    if (pk && Object.hasOwn(baselines, pk[1])) shard = pk[1];',
  '    if (!shard && /root shard/i.test(line) && Object.hasOwn(baselines, "root")) shard = "root";',
  '    if (!shard) for (const k of keys) { if (new RegExp("\\\\b" + k.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&") + "\\\\b").test(line)) { shard = k; break; } }',
  '    if (!shard) { R.expectations_skipped.push({ reason: "no baseline shard identifiable on the line", text: line.slice(0, 200) }); continue; }',
  '    const base = baselines[shard];',
  '    lines[i] = line.replace(/(\\d{3,})(\\s+pass\\b)/g, (whole, num, tail, offset) => {',
  '      const before = line.slice(Math.max(0, offset - 12), offset);',
  '      if (/baseline\\s*\\+\\s*$/.test(before)) return whole;',
  '      const n = Number(num);',
  '      if (n < base) { R.expectations_skipped.push({ reason: "count " + n + " is below the " + shard + " baseline " + base, text: line.slice(0, 200) }); return whole; }',
  '      const delta = n - base;',
  '      R.expectations_rewritten.push({ shard, from: num + " pass", to: (delta === 0 ? "baseline" : "baseline + " + delta) + " pass" });',
  '      return (delta === 0 ? "baseline" : "baseline + " + delta) + tail;',
  '    });',
  '  }',
  '}',
  '',
  'const parts = [];',
  'if (CFG.preamble.trim()) parts.push(CFG.preamble.replace(/\\s+$/, ""));',
  'for (const p of CFG.phases) {',
  '  const f = path.join(CFG.runDir, "phases", "phase-" + p.n + ".md");',
  '  if (!fs.existsSync(f)) { R.missing_phase_files.push(p.n); continue; }',
  '  let body = fs.readFileSync(f, "utf8").replace(/\\r\\n/g, "\\n").split("\\n");',
  '  body = unwrapFence(body, p.n);',
  '  body = stripAuthorHeader(body, p.n);',
  '  const kept = [];',
  '  let fenced = false;',
  '  for (const l of body) {',
  '    if (l.trim().startsWith("```")) { fenced = !fenced; kept.push(l); continue; }',
  '    if (!fenced && DEBRIS.some((re) => re.test(l))) { R.debris_stripped.push({ phase: p.n, reason: "assembly debris", text: l.slice(0, 160) }); continue; }',
  '    kept.push(l);',
  '  }',
  '  const header = "## Phase " + p.n + CFG.sep + p.title;',
  '  R.phase_headers.push(header);',
  '  parts.push(header);',
  '  parts.push(kept.join("\\n").replace(/^\\n+/, "").replace(/\\s+$/, ""));',
  '  R.phases_assembled++;',
  '}',
  '',
  'let lines = parts.join("\\n\\n").split("\\n");',
  'let st = fenceState(lines);',
  'R.meta_blocks_found = st.metaBlocks.length;',
  'quoteIds(lines, st.metaBlocks);',
  'let tasks = parseTasks(lines, st.metaBlocks);',
  'R.tasks_parsed = tasks.length;',
  'const seen = new Map();',
  'for (const t of tasks) { if (!t.id) continue; if (seen.has(t.id)) R.duplicate_ids.push(t.id); seen.set(t.id, true); }',
  'fixFileScope(lines, tasks);',
  'const baselines = parseBaselines(lines);',
  'R.baselines_used = baselines;',
  'rewriteExpectations(lines, st.inFence, baselines);',
  'rewriteGraphs(lines, tasks);',
  '',
  'let headerRe = null;',
  'try { headerRe = new RegExp(CFG.headerRegexSource); } catch (e) { headerRe = null; }',
  'for (const h of R.phase_headers) if (!headerRe || !headerRe.test(h)) R.headers_failing_regex.push(h);',
  '',
  'const out = lines.join("\\n").replace(/\\n{4,}/g, "\\n\\n\\n").replace(/\\s+$/, "") + "\\n";',
  'fs.mkdirSync(path.dirname(CFG.planPath), { recursive: true });',
  'fs.writeFileSync(CFG.planPath, out);',
  'R.bytes = fs.statSync(CFG.planPath).size;',
  'process.stdout.write(JSON.stringify(R));',
].join('\n')

const FIXER_CONFIG = {
  planPath: PLAN_PATH,
  runDir: RUN_DIR,
  repo: REPO,
  sep,
  headerRegexSource,
  preamble,
  baselines,
  phases: phaseReports.map((p) => ({ n: p.n, title: (phaseSpecs.find((s) => s.n === p.n) || {}).title || '' })).sort((x, y) => x.n - y.n),
}
const FIXER_SOURCE = 'const CFG = ' + JSON.stringify(FIXER_CONFIG) + ';\n' + FIXER_LINES + '\n'
const FIXER_BYTES =
  typeof TextEncoder === 'function' ? new TextEncoder().encode(FIXER_SOURCE).length : -1
const FIXER_PATH = RUN_DIR + '/plan-fixer.generated.cjs'

const fixerRun = await agent(
  [
    'Write the program below to ' + FIXER_PATH + ' BYTE FOR BYTE, then run it. Do not edit it, reformat it, or "fix" anything in it — it is generated and its behaviour is the contract.',
    '',
    'Steps, in order:',
    '1. mkdir -p ' + RUN_DIR,
    '2. Write the file exactly as given between the markers below (a quoted heredoc is the safe way).',
    FIXER_BYTES > 0
      ? '3. Report its size: wc -c < ' + FIXER_PATH + '   -> fixer_bytes_written. It must be ' + FIXER_BYTES + '. If it is not, you transcribed it wrong; rewrite it before running.'
      : '3. Report its size: wc -c < ' + FIXER_PATH + '   -> fixer_bytes_written.',
    '4. Run it:  cd ' + REPO + ' && bun ' + FIXER_PATH + ' > ' + RUN_DIR + '/fixer-report.json 2> ' + RUN_DIR + '/fixer.err',
    '   then, on its own line:  echo "EXIT=$?"',
    '   Do not pipe it into head or tail before reading the status.',
    '5. Return the exit code and the CONTENTS of ' + RUN_DIR + '/fixer-report.json verbatim as report_json. It is one JSON object. Do not summarize it, reformat it or drop fields. If the run failed, return the exit code and put the stderr in report_json.',
    '',
    '----- BEGIN PROGRAM -----',
    FIXER_SOURCE,
    '----- END PROGRAM -----',
  ].join('\n'),
  { label: 'assemble+fix', phase: 'Assemble', schema: FIXER_SCHEMA, model: 'sonnet' },
).catch(() => null)

let fixReport = null
let fixParseError = null
if (fixerRun && typeof fixerRun.report_json === 'string') {
  try {
    fixReport = JSON.parse(fixerRun.report_json)
  } catch (err) {
    fixParseError = 'fixer report was not valid JSON: ' + String(fixerRun.report_json).slice(0, 200)
  }
}
// FIXER_BYTES is -1 only when the runtime has no TextEncoder; in that case the
// receipt cannot be checked and the run says so rather than claiming it was.
const fixerTranscribed =
  FIXER_BYTES > 0 ? !!fixerRun && fixerRun.fixer_bytes_written === FIXER_BYTES : !!fixerRun
const fixerOk = !!fixerRun && fixerRun.exit_code === 0 && !!fixReport && fixerTranscribed

if (!fixerOk) {
  return {
    ok: false,
    error: 'assembly_failed: the deterministic fixer did not complete; the plan on disk is not trustworthy',
    plan_path: PLAN_PATH,
    context: { seats: seats.length },
    phases: { requested: phaseSpecs.length, authored: phaseReports.length, failed: phasesFailed },
    fixer: {
      expected_bytes: FIXER_BYTES,
      reported_bytes: fixerRun ? fixerRun.fixer_bytes_written : null,
      transcribed_intact: FIXER_BYTES > 0 ? fixerTranscribed : null,
      exit_code: fixerRun ? fixerRun.exit_code : null,
      parse_error: fixParseError,
    },
    fixes: fixReport,
    audit: null,
    validator: null,
  }
}

log(
  'plan-author-audit: assembled ' + fixReport.phases_assembled + ' phases, ' + fixReport.tasks_parsed + ' tasks, ' +
    fixReport.ids_quoted.length + ' ids quoted, ' + fixReport.graphs_rewritten.length + ' dispatch graphs rewritten',
)

// ------------------------------------------------------------------ audit ---
phase('Audit')

const auditPrompt = [
  'Audit the ASSEMBLED plan document at ' + PLAN_PATH + '. Read the whole file. You are not reviewing the engineering; you are hunting the defects that make a plan unrunnable.',
  '',
  '## The constraints it must satisfy (generated from the live repo this run)',
  constraintBlock,
  '',
  '## Seats it may pin',
  seats.join(', '),
  '',
  '## What to hunt, worst first',
  '1. VALIDATOR FAILURES — anything the plan validator rejects: an unregistered preferred_agent / fallback_agent, a depends_on target that does not exist, a non-reciprocal parallel_with, a depends_on cycle, `file_scope: new` on a path that exists.',
  '2. DUPLICATE OR MALFORMED IDS — two tasks sharing an id, an unquoted decimal id, an id that does not match its phase number.',
  '3. PLACEHOLDERS — TODO, TBD, `<...>`, "as above", "similar to the previous task", a step that defers the actual assertion.',
  '4. CROSS-PHASE NAMING INCONSISTENCY — the same function, file, flag, column, event kind or schema named differently in two phases. This is the defect that makes phase N+1 unimplementable and it is invisible inside any single phase.',
  '5. ORDERING VIOLATIONS — a task that reads a value an earlier phase has not yet written; a gate armed in one phase whose release path lands in a later one; a test whose RED depends on a later phase.',
  '6. FABRICATED EVIDENCE — open the cited file:line for every load-bearing claim you can and check it says what the plan says. Report every citation that does not.',
  '',
  'Structural checks already done mechanically before you ran, so do NOT re-report them unless the file contradicts this: ' + fixReport.tasks_parsed + ' tasks parsed from ' + fixReport.meta_blocks_found + ' yaml meta blocks, ' + fixReport.ids_quoted.length + ' ids quoted, ' + fixReport.graphs_rewritten.length + ' dispatch graphs regenerated, ' + fixReport.file_scope_corrected.length + ' file_scope values corrected.',
  'Do report it as blocking if you find a task the parse missed, an unclosed fence, or a `## ` line sitting between a `### ` task heading and its yaml block.',
  '',
  'verdict is dispatch_ready only if blocking is empty. Every finding needs a real line number or task id.',
].join('\n')

const validateCommand =
  'cd ' + REPO + ' && bun packages/cli/bin/penumbra.ts plan validate ' + PLAN_PATH + ' > /tmp/plan-validate.out 2> /tmp/plan-validate.err'

const [audit, validator] = await parallel([
  () => agent(auditPrompt, { label: 'audit', phase: 'Audit', schema: AUDIT_SCHEMA, agentType: 'Explore', model: auditModel }).catch(() => null),
  () =>
    agent(
      [
        'Run the real plan validator and report exactly what it said.',
        '',
        '    ' + validateCommand,
        '    echo "EXIT=$?"',
        '',
        'Read the exit code on its OWN line as shown; do not pipe into head or tail first.',
        'Then return the exit code and every line of /tmp/plan-validate.err verbatim as stderr_lines (empty array if the file is empty).',
        'Do not interpret, filter or fix anything. If the validator warns that the daemon agent registry is unreachable, include that warning line — it means the seat checks in this run were made against a five-name fallback list and are not trustworthy.',
      ].join('\n'),
      { label: 'validate', phase: 'Audit', schema: VALIDATE_SCHEMA, model: 'sonnet' },
    ).catch(() => null),
]);

// ----------------------------------------------------------------- digest ---
const blocking = []
if (phasesFailed.length) blocking.push('phases that produced nothing: ' + phasesFailed.join(', '))
if (fixReport.missing_phase_files.length) blocking.push('phase files absent at assembly: ' + fixReport.missing_phase_files.join(', '))
if (seatViolations.length) {
  blocking.push('seats pinned outside the generated list: ' + seatViolations.map((s) => 'phase ' + s.phase + ':' + s.seat).join(', '))
}
if (fixReport.headers_failing_regex.length) {
  blocking.push('phase headers that do not match the live registrar regex (they would vanish from the registrar silently): ' + fixReport.headers_failing_regex.join(' | '))
}
if (fixReport.duplicate_ids.length) blocking.push('duplicate task ids: ' + fixReport.duplicate_ids.join(', '))
if (fixReport.meta_blocks_unclosed > 0) {
  blocking.push(fixReport.meta_blocks_unclosed + ' unclosed yaml meta block(s) — each deletes its task from the parse with no error')
}
if (fixReport.heading_clobbered.length) {
  blocking.push('tasks whose heading is erased by a "## " line before the yaml block: ' + fixReport.heading_clobbered.map((h) => String(h.id)).join(', '))
}
if (fixReport.graph_cycles.length) blocking.push('depends_on cycle in phase(s): ' + fixReport.graph_cycles.join(', '))
if (!validator) blocking.push('the plan validator was not run; validity is unknown')
else if (validator.exit_code !== 0) blocking.push('plan validate exited ' + validator.exit_code + ': ' + (validator.stderr_lines || []).slice(0, 10).join(' | '))
if (!audit) blocking.push('the audit agent returned nothing')
else if (Array.isArray(audit.blocking) && audit.blocking.length) {
  blocking.push('audit found ' + audit.blocking.length + ' blocking issue(s): ' + audit.blocking.map((b) => b.category + '@' + b.location).join(', '))
}

const ok = blocking.length === 0 && phaseReports.length === phaseSpecs.length

return {
  ok,
  plan_path: PLAN_PATH,
  run_dir: RUN_DIR,
  context: {
    command: context.command,
    seats_available: seats.length,
    phase_header_separator: JSON.stringify(sep),
    gate_commands: gateCommands.length,
  },
  phases: {
    requested: phaseSpecs.length,
    authored: phaseReports.length,
    failed: phasesFailed,
    assembled: fixReport.phases_assembled,
    tasks_parsed: fixReport.tasks_parsed,
    task_ids: phaseReports.reduce((acc, p) => acc.concat(Array.isArray(p.task_ids) ? p.task_ids : []), []),
  },
  fixes: {
    ids_quoted: fixReport.ids_quoted.length,
    dep_ids_quoted: fixReport.dep_ids_quoted.length,
    graphs_rewritten: fixReport.graphs_rewritten,
    file_scope_corrected: fixReport.file_scope_corrected,
    file_scope_suspect: fixReport.file_scope_suspect,
    debris_stripped: fixReport.debris_stripped.length,
    fences_unwrapped: fixReport.fences_unwrapped,
    expectations_rewritten: fixReport.expectations_rewritten.length,
    expectations_skipped: fixReport.expectations_skipped,
    baselines_used: fixReport.baselines_used,
    plan_bytes: fixReport.bytes,
  },
  seat_violations: seatViolations,
  audit: audit
    ? {
        verdict: audit.verdict,
        blocking: audit.blocking,
        advisory_count: Array.isArray(audit.advisory) ? audit.advisory.length : 0,
        fabricated_evidence: audit.fabricated_evidence,
      }
    : null,
  validator: validator ? { exit_code: validator.exit_code, stderr_lines: validator.stderr_lines } : null,
  blocking,
  next: ok
    ? 'Register it: `bun packages/cli/bin/penumbra.ts registrar register ' + PLAN_PATH + '` creates an ACTIVE entry; only mcp__penumbra__registrar_create can set status "draft". After registering, count the phase headers in the file against the phases the registrar echoed back.'
    : 'Resolve the blocking list before registering or dispatching anything.',
}
