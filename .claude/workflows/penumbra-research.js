export const meta = {
  name: 'penumbra-research',
  description: 'Memory-augmented research: prime with penumbra t2 memory, fan out sourced web research across sub-questions, synthesize a cited report, then persist it back to t2 memory for cross-session recall. The penumbra-native augmentation of /deep-research.',
  whenToUse: 'When you want a researched, cited answer that (a) starts from what penumbra already knows and (b) is remembered next session. Pass the question as args (string) or { question, angles?, persist?, researchModel? }. Requires WebSearch + WebFetch to be available/allowlisted.',
  phases: [
    { title: 'Prime', detail: 'recall prior penumbra t2 memory on the question' },
    { title: 'Research', detail: 'split into sub-questions, then fan out sourced web research' },
    { title: 'Synthesize', detail: 'merge prior knowledge + findings into a cited report' },
    { title: 'Persist', detail: 'write the report summary back to t2 memory' },
  ],
}

let input = args
if (typeof input === 'string') {
  const s = input.trim()
  if (s.startsWith('{')) {
    try {
      input = JSON.parse(s)
    } catch {
      /* keep as question string */
    }
  }
}
const question = typeof input === 'string' ? input : input && input.question
if (!question || !String(question).trim()) {
  log('penumbra-research: no question. Pass the question as args (string) or args.question.')
  return { ok: false, error: 'no_question' }
}
const opts = typeof input === 'object' && input ? input : {}
const nAngles = opts.angles || 4
const persist = opts.persist !== false // default true
const researchModel = opts.researchModel || 'sonnet' // default: sonnet for source extraction; caller can pass 'opus' for hard questions or 'inherit'

phase('Prime')
const prime = await agent(
  [
    'Recall what penumbra already knows that is relevant to this question, so the research does not re-derive solved problems.',
    `Question: ${question}`,
    'Call mcp__penumbra__memory_search with the question (and 1-2 keyword variants). Return a concise brief of the most relevant prior findings/decisions, or state plainly that memory has nothing relevant.',
  ].join('\n'),
  {
    label: 'prime',
    phase: 'Prime',
    model: 'sonnet', // mechanical memory recall
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: { brief: { type: 'string' }, hits: { type: 'number' } },
    },
  },
)

phase('Research')
const plan = await agent(
  [
    `Break this research question into ${nAngles} independent sub-questions that together cover it, each answerable from distinct sources.`,
    `Question: ${question}`,
    prime && prime.brief ? `Prior knowledge (avoid re-researching these):\n${prime.brief}` : '',
    'Return StructuredOutput: subquestions (array of strings).',
  ]
    .filter(Boolean)
    .join('\n'),
  {
    label: 'plan-angles',
    phase: 'Research',
    model: 'sonnet', // light decomposition
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['subquestions'],
      properties: { subquestions: { type: 'array', items: { type: 'string' } } },
    },
  },
)

const subqs = ((plan && plan.subquestions) || []).slice(0, nAngles)
const FINDING = {
  type: 'object',
  additionalProperties: false,
  required: ['subquestion', 'findings'],
  properties: {
    subquestion: { type: 'string' },
    findings: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
}
const findings = (
  await parallel(
    subqs.map((sq, i) => () =>
      agent(
        [
          'Research this sub-question using WebSearch and WebFetch. Cross-check across at least two independent sources. Report concise findings with the source URLs you relied on.',
          `Sub-question: ${sq}`,
          'Return StructuredOutput: subquestion, findings, sources (URLs).',
        ].join('\n'),
        {
          label: `research#${i}`,
          phase: 'Research',
          schema: FINDING,
          ...(researchModel && researchModel !== 'inherit' ? { model: researchModel } : {}),
        },
      ),
    ),
  )
).filter(Boolean)

phase('Synthesize')
const report = await agent(
  [
    'Synthesize a cited report answering the question. Use the prior-knowledge brief and the per-sub-question findings. Attribute claims to their sources; flag anything uncertain or unsupported. Keep it tight.',
    `Question: ${question}`,
    prime && prime.brief ? `Prior knowledge:\n${prime.brief}` : '',
    'Findings:',
    JSON.stringify(findings, null, 2),
    'Return StructuredOutput: report (markdown, ending with a Sources section) and a one-paragraph summary.',
  ].join('\n'),
  {
    label: 'synthesize',
    phase: 'Synthesize',
    model: 'opus', // the cited-report synthesis is the quality-determining judgment
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['report', 'summary'],
      properties: { report: { type: 'string' }, summary: { type: 'string' } },
    },
  },
)

let persisted = false
if (persist && report && report.summary) {
  phase('Persist')
  const p = await agent(
    [
      'Persist this research summary to penumbra long-term memory so future sessions can recall it.',
      `Call mcp__penumbra__memory_observe with a concise observation capturing the question and the key finding.`,
      `Question: ${question}`,
      `Summary to store:\n${report.summary}`,
      'If mcp__penumbra__memory_observe is unavailable or errors, do NOT fail — return persisted:false with a note explaining why.',
      'Return StructuredOutput: { persisted: boolean, note?: string }.',
    ].join('\n'),
    {
      label: 'persist',
      phase: 'Persist',
      model: 'sonnet', // single memory_observe call
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['persisted'],
        properties: { persisted: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
  )
  persisted = !!(p && p.persisted)
}

return {
  ok: !!(report && report.report),
  question,
  prior_knowledge: prime && prime.brief,
  subquestions: subqs,
  findings,
  report: report && report.report,
  summary: report && report.summary,
  persisted,
}
