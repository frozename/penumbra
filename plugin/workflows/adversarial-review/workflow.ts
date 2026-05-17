import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowFn, WorkflowSpec, RecallBundle, WorkflowCtx } from '@penumbra/workflows';
import { z } from 'zod';
import { resolveOutDir, sanitizeFileStem } from '../_shared/io.js';

type ReviewPersona = {
  name: string;
  bias: string;
  system_prompt: string;
  preferred_agent: string;
  category_hints?: string[];
};

type ReviewSynthesizer = {
  preferred_agent: string;
  system_prompt: string;
};

export const inputSchema = z.object({
  target_ref: z.string().default('HEAD'),
  base_ref: z.string().default('main'),
  personas: z.array(z.string().min(1)).optional(),
  content_path: z.string().optional(),
  timeout_ms: z.number().int().positive().default(600000),
  out_dir: z.string().optional(),
}).strict();

export type Input = z.infer<typeof inputSchema>;

const TRIVIAL_RESPONSE_THRESHOLD = 200;

type PersonaRunResult = {
  persona: string;
  persona_key: string;
  bias: string;
  status: 'completed' | 'failed' | 'timeout';
  raw_status: 'completed' | 'failed' | 'timeout';
  response_text: string | null;
  conversation_id: string | null;
  handoff_id: string | null;
  error?: string;
  findings: unknown[] | null;
  parse_error?: 'no_json_block' | 'invalid_json';
  triviality_reason?: 'trivial_response' | 'no_findings';
};

const spec: WorkflowSpec = {
  name: 'adversarial-review',
  description: 'Fan out a code review across N reviewer personas with distinct biases; synthesize findings.',
  triggers: [{ kind: 'manual' }, { kind: 'slash', command: 'adversarial-review' }],
  recall: [
    { source: 'git.diff', args: { range: '{{args.base_ref}}...{{args.target_ref}}' } },
    { source: 'git.show', args: { range: '{{args.base_ref}}..{{args.target_ref}}', max_commits: 20 } },
    { source: 'file.contents', args: { path: '{{args.content_path}}' } },
  ],
  recall_budget_tokens: 24000,
  output: [],
  run: { kind: 'ts-function' },
};

function getPersonas(ctx: WorkflowCtx): Record<string, ReviewPersona> | null {
  const raw = ctx.config.review_personas;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => value && typeof value === 'object' && !Array.isArray(value),
  ) as Array<[string, Record<string, unknown>]>;
  if (entries.length === 0) return null;

  const out: Record<string, ReviewPersona> = {};
  for (const [key, value] of entries) {
    const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : key;
    if (
      typeof value.bias !== 'string' ||
      value.bias.length === 0 ||
      typeof value.system_prompt !== 'string' ||
      value.system_prompt.length === 0 ||
      typeof value.preferred_agent !== 'string' ||
      value.preferred_agent.length === 0
    ) {
      continue;
    }
    out[key] = {
      name,
      bias: value.bias,
      system_prompt: value.system_prompt,
      preferred_agent: value.preferred_agent,
      category_hints: Array.isArray(value.category_hints)
        ? value.category_hints.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : undefined,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function getSynthesizer(ctx: WorkflowCtx): ReviewSynthesizer | null {
  const raw = ctx.config.review_synthesizer as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (
    typeof raw.preferred_agent !== 'string' ||
    raw.preferred_agent.length === 0 ||
    typeof raw.system_prompt !== 'string' ||
    raw.system_prompt.length === 0
  ) {
    return null;
  }
  return {
    preferred_agent: raw.preferred_agent,
    system_prompt: raw.system_prompt,
  };
}

function formatGitShow(recall: RecallBundle): string {
  const commits = recall.byKey['git.show'];
  if (!Array.isArray(commits) || commits.length === 0) return '(none)';
  return commits
    .map((commit) => {
      if (!commit || typeof commit !== 'object') return null;
      const row = commit as Record<string, unknown>;
      const sha = typeof row.sha === 'string' ? row.sha : '';
      const subject = typeof row.subject === 'string' ? row.subject : '';
      const ts = typeof row.ts === 'string' ? row.ts : '';
      const body = typeof row.body === 'string' ? row.body : '';
      return `- ${sha} ${subject} (${ts})\n${body}`.trim();
    })
    .filter((x): x is string => Boolean(x))
    .join('\n\n');
}

function fileContentsBody(recall: RecallBundle): string {
  const fileContents = recall.byKey['file.contents'];
  if (!fileContents || typeof fileContents !== 'object' || Array.isArray(fileContents)) return '';
  const body = (fileContents as Record<string, unknown>).body;
  return typeof body === 'string' ? body : '';
}

function renderPersonaPrompt(persona: ReviewPersona, recall: RecallBundle, args: Input): string {
  const gitDiff = typeof recall.byKey['git.diff'] === 'string' ? (recall.byKey['git.diff'] as string) : '';
  const commits = formatGitShow(recall);
  const content = fileContentsBody(recall);
  const categoryHints = persona.category_hints && persona.category_hints.length > 0
    ? persona.category_hints.join(', ')
    : 'any';

  // When content_path is passed, the file body is the authoritative diff to review.
  // git.diff and git.show recall fetched from the workflow's cwd, which can be the
  // daemon's cwd (penumbra) rather than the target repo — drop the misleading
  // sections to prevent personas from reviewing the wrong thing.
  const useContent = typeof args.content_path === 'string' && args.content_path.length > 0 && content.length > 0;
  const diffBody = useContent ? content : gitDiff;
  const reviewTarget = useContent
    ? `content_path=${args.content_path}\nbase_ref=${args.base_ref}\ntarget_ref=${args.target_ref}\n\nThe Diff section below comes from the explicit content_path file — this is the authoritative review target. Ignore any git context from your worktree.`
    : `base_ref=${args.base_ref}\ntarget_ref=${args.target_ref}`;
  const commitsSection = useContent ? '' : `\n## Recent commits\n${commits}\n`;

  return `You are reviewing code as a ${persona.bias} reviewer.

${persona.system_prompt}

## Review Target
${reviewTarget}

## Diff
\`\`\`diff
${diffBody}
\`\`\`
${commitsSection}
## Output format
Return your review as markdown, then a fenced \`\`\`json [...]\`\`\` block at the very end with an array of findings:

{"persona":"${persona.name}","severity":"high|medium|low|info","category":"...","file":"...","line":0,"title":"short","details":"longer","suggestion":"..."}

The category should be one of ${categoryHints}.`;
}

function parseFindingsJson(responseText: string | null): {
  findings: unknown[] | null;
  parse_error?: 'no_json_block' | 'invalid_json';
} {
  if (!responseText || responseText.length === 0) return { findings: null, parse_error: 'no_json_block' };
  const pattern = /```json\s*([\s\S]*?)```/gi;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(responseText))) {
    last = match[1] ?? '';
  }
  if (last === null) return { findings: null, parse_error: 'no_json_block' };
  try {
    const parsed = JSON.parse(last);
    if (!Array.isArray(parsed)) return { findings: null, parse_error: 'invalid_json' };
    return { findings: parsed };
  } catch {
    return { findings: null, parse_error: 'invalid_json' };
  }
}

function isTrivialResponse(text: string | null): boolean {
  return !text || text.trim().length < TRIVIAL_RESPONSE_THRESHOLD;
}

function synthesisPrompt(
  synth: ReviewSynthesizer,
  selected: ReviewPersona[],
  personaResults: PersonaRunResult[],
): string {
  const sections = selected.map((persona) => {
    const result = personaResults.find((r) => r.persona === persona.name);
    if (!result) return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: missing result`;
    if (result.status !== 'completed') {
      return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: ${result.triviality_reason ?? result.error ?? result.status}`;
    }
    return `### ${persona.name} (${persona.bias})\n${result.response_text ?? ''}`;
  });

  return `${synth.system_prompt}

You are synthesizing ${selected.length} adversarial reviews. Each persona reviewed the same diff with a different lens.

## Reviews
${sections.join('\n\n')}

## Output

Reply with the synthesis content as your message. Do NOT write any files; do NOT use any file-writing tools. The harness will save your reply text directly. Your reply should contain, in this order:

1. Headline — one sentence: should this change land as-is, with revisions, or be rejected?
2. Shared concerns — issues raised by 2+ personas (or "none — single persona" if only one).
3. Contradictions — where personas disagreed (or "none").
4. Severity-ranked findings — combine all personas' JSON findings into one flat ranked list (high → low). Dedupe near-identical findings; cite which personas raised each.
5. Recommended actions — concrete, ordered. Each action references finding numbers.
6. Skipped/failed personas — note any DISPATCH FAILED entries with their reason.

Begin your reply with the headline. No preamble.`;
}

function buildSynthesisFrontmatter(args: {
  review_run_ts: string;
  synthesis_handoff_id: string;
  persona_handoff_ids: Record<string, string>;
  target_ref: string;
  base_ref: string;
}): string {
  const lines = [
    '---',
    `review_run_ts: ${args.review_run_ts}`,
    `synthesis_handoff_id: ${args.synthesis_handoff_id}`,
    'persona_handoff_ids:',
  ];
  for (const [key, id] of Object.entries(args.persona_handoff_ids)) {
    lines.push(`  ${key}: ${id}`);
  }
  lines.push(`target_ref: ${args.target_ref}`);
  lines.push(`base_ref: ${args.base_ref}`);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

export const fn: WorkflowFn<Input> = async (ctx, recall) => {
  const personasByKey = getPersonas(ctx);
  if (!personasByKey) {
    return {
      ok: false,
      error: 'no_personas_configured',
      hint: 'add review_personas to ~/.config/agentchat/agentchat.yaml',
    };
  }

  const synthesizer = getSynthesizer(ctx);
  if (!synthesizer) {
    return {
      ok: false,
      error: 'no_synthesizer_configured',
      hint: 'add review_synthesizer to ~/.config/agentchat/agentchat.yaml',
    };
  }

  const personaKeys = Object.keys(personasByKey);
  const parsedArgs = ctx.args;
  const requestedPersonas = parsedArgs.personas ?? personaKeys;
  const missing = requestedPersonas.filter((name) => !personasByKey[name]);
  if (missing.length > 0) {
    return {
      ok: false,
      error: 'unknown_personas',
      missing_personas: missing,
      hint: `available personas: ${personaKeys.join(', ')}`,
    };
  }
  const selected = requestedPersonas.map((key) => personasByKey[key]!).filter(Boolean);
  if (selected.length === 0) {
    return {
      ok: false,
      error: 'no_personas_selected',
      hint: `available personas: ${personaKeys.join(', ')}`,
    };
  }

  const outDirResolution = resolveOutDir(ctx, parsedArgs.out_dir);
  if (!outDirResolution.ok) {
    return {
      ok: false,
      error: 'out_dir_outside_allowed_roots',
    };
  }
  const absoluteOutDir = outDirResolution.path;
  const reviewRunTs = new Date().toISOString();
  await mkdir(absoluteOutDir, { recursive: true });

  const writePersonaOutputs = async (result: PersonaRunResult): Promise<void> => {
    const stem = sanitizeFileStem(result.persona);
    const jsonPath = join(absoluteOutDir, `${stem}.json`);
    const mdPath = join(absoluteOutDir, `${stem}.md`);
    await ctx.fileWrite(
      jsonPath,
      JSON.stringify(
        {
          persona: result.persona,
          status: result.status,
          raw_status: result.raw_status,
          triviality_reason: result.triviality_reason,
          response_text: result.response_text,
          findings: result.findings,
          conversation_id: result.conversation_id,
          parse_error: result.parse_error,
          error: result.error,
        },
        null,
        2,
      ),
    );
    const mdBody = result.status === 'completed'
      ? (result.response_text ?? '')
      : `<dispatch failed: ${result.error ?? result.status}>`;
    await ctx.fileWrite(mdPath, mdBody);
  };

  const personaResults = await Promise.all(
    requestedPersonas.map(async (key): Promise<PersonaRunResult> => {
      const persona = personasByKey[key]!;
      try {
        const dispatch = await ctx.dispatch({
          agent: persona.preferred_agent,
          message: `cd ${ctx.cwd}\n\n${renderPersonaPrompt(persona, recall, parsedArgs)}`,
          task_type: 'review_adversarial',
          use_worktree: false,
        });
        const wait = await ctx.awaitChain(dispatch.conversation_id, { timeoutMs: parsedArgs.timeout_ms });
        const parsed = parseFindingsJson(wait.response_text);
        let effectiveStatus = wait.status;
        let trivialityReason: PersonaRunResult['triviality_reason'];
        if (
          effectiveStatus === 'completed' &&
          isTrivialResponse(wait.response_text) &&
          parsed.findings === null
        ) {
          effectiveStatus = 'failed';
          trivialityReason = 'trivial_response';
        }
        const result: PersonaRunResult = {
          persona: persona.name,
          persona_key: key,
          bias: persona.bias,
          status: effectiveStatus,
          raw_status: wait.status,
          triviality_reason: trivialityReason,
          response_text: wait.response_text,
          conversation_id: dispatch.conversation_id,
          handoff_id: dispatch.handoff_id,
          findings: parsed.findings,
          parse_error: parsed.parse_error,
        };
        await writePersonaOutputs(result);
        return result;
      } catch (err) {
        const result: PersonaRunResult = {
          persona: persona.name,
          persona_key: key,
          bias: persona.bias,
          status: 'failed',
          raw_status: 'failed',
          response_text: null,
          conversation_id: null,
          handoff_id: null,
          error: err instanceof Error ? err.message : String(err),
          findings: null,
        };
        await writePersonaOutputs(result);
        return result;
      }
    }),
  );

  const completedResults = personaResults.filter(
    (result) => result.status === 'completed' && typeof result.response_text === 'string' && result.response_text.length > 0,
  );

  if (completedResults.length === 0) {
    return {
      ok: false,
      out_dir: absoluteOutDir,
      personas: personaResults.map((result) => ({
        name: result.persona,
        status: result.status,
        conversation_id: result.conversation_id,
        findings_count: Array.isArray(result.findings) ? result.findings.length : null,
      })),
      synthesis_path: null,
      synthesizer_status: null,
      error: 'all_persona_dispatches_failed',
      hint: 'all persona dispatches failed or timed out',
    };
  }

  let synthesisPath: string | null = null;
  let synthStatus: 'completed' | 'failed' | 'timeout' | null = null;
  let synthHandoffId: string | null = null;
  const personaHandoffIds: Record<string, string> = {};
  for (const r of personaResults) {
    if (r.handoff_id) {
      personaHandoffIds[r.persona_key] = r.handoff_id;
    }
  }
  try {
    const synthDispatch = await ctx.dispatch({
      agent: synthesizer.preferred_agent,
      message: `cd ${ctx.cwd}\n\n${synthesisPrompt(synthesizer, selected, personaResults)}`,
      task_type: 'review_adversarial',
      use_worktree: false,
    });
    synthHandoffId = synthDispatch.handoff_id;
    const synthWait = await ctx.awaitChain(synthDispatch.conversation_id, { timeoutMs: parsedArgs.timeout_ms });
    synthStatus = synthWait.status;
    synthesisPath = join(absoluteOutDir, 'synthesis.md');
    const frontmatter = buildSynthesisFrontmatter({
      review_run_ts: reviewRunTs,
      synthesis_handoff_id: synthHandoffId,
      persona_handoff_ids: personaHandoffIds,
      target_ref: parsedArgs.target_ref,
      base_ref: parsedArgs.base_ref,
    });
    await ctx.fileWrite(
      synthesisPath,
      synthWait.status === 'completed'
        ? frontmatter + (synthWait.response_text ?? '')
        : frontmatter + `<synthesizer failed: ${synthWait.status}>`,
    );
  } catch (err) {
    synthStatus = 'failed';
    synthesisPath = join(absoluteOutDir, 'synthesis.md');
    const frontmatter = synthHandoffId
      ? buildSynthesisFrontmatter({
          review_run_ts: reviewRunTs,
          synthesis_handoff_id: synthHandoffId,
          persona_handoff_ids: personaHandoffIds,
          target_ref: parsedArgs.target_ref,
          base_ref: parsedArgs.base_ref,
        })
      : '';
    await ctx.fileWrite(
      synthesisPath,
      frontmatter + `<synthesizer failed: ${err instanceof Error ? err.message : String(err)}>`,
    );
  }

  return {
    ok: true,
    out_dir: absoluteOutDir,
    personas: personaResults.map((result) => ({
      name: result.persona,
      status: result.status,
      conversation_id: result.conversation_id,
      findings_count: Array.isArray(result.findings) ? result.findings.length : null,
    })),
    synthesis_path: synthesisPath,
    synthesizer_status: synthStatus,
  };
};

export default spec;
