import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { WorkflowFn, WorkflowSpec, RecallBundle, WorkflowCtx } from '@penumbra/workflows';
import { z } from 'zod';

type PlannerPersona = {
  name: string;
  bias: string;
  system_prompt: string;
  preferred_agent: string;
};

type PlanSynthesizer = {
  preferred_agent: string;
  system_prompt: string;
};

export const inputSchema = z.object({
  topic: z.string().optional(),
  content_path: z.string().optional(),
  personas: z.array(z.string().min(1)).optional(),
  timeout_ms: z.number().int().positive().default(600000),
  out_dir: z.string().optional(),
}).strict();

export type Input = z.infer<typeof inputSchema>;

type PersonaRunResult = {
  persona: string;
  persona_key: string;
  bias: string;
  status: 'completed' | 'failed' | 'timeout';
  response_text: string | null;
  conversation_id: string | null;
  handoff_id: string | null;
  error?: string;
};

const spec: WorkflowSpec = {
  name: 'adversarial-plan',
  description: 'Fan out a planning topic across N planner personas with distinct biases; synthesize a phased TDD plan.',
  triggers: [{ kind: 'manual' }, { kind: 'slash', command: 'adversarial-plan' }],
  recall: [
    { source: 'file.contents', args: { path: '{{args.content_path}}' } },
  ],
  recall_budget_tokens: 12000,
  output: [],
  run: { kind: 'ts-function' },
};

function timestampSlug(now: Date): string {
  return now.toISOString().replace(/:/g, '-');
}

function resolveOutDir(ctx: WorkflowCtx, outDirArg: string | undefined): { ok: true; path: string } | { ok: false } {
  const defaultOutDir = join(ctx.cwd, '.penumbra', 'reviews', timestampSlug(new Date()));
  const outDir = !outDirArg ? defaultOutDir : isAbsolute(outDirArg) ? resolve(outDirArg) : resolve(ctx.cwd, outDirArg);
  const realOutDir = canonicalizePathForWrite(outDir);
  const roots = [ctx.cwd, ctx.storageRoot].map(canonicalizePathForWrite);
  const allowed = roots.some((root) => realOutDir === root || realOutDir.startsWith(`${root}${sep}`));
  if (!allowed) return { ok: false };
  return { ok: true, path: outDir };
}

function canonicalizePathForWrite(path: string): string {
  const absPath = resolve(path);
  try {
    return realpathSync(absPath);
  } catch {
    const missing: string[] = [];
    let cursor = absPath;
    for (;;) {
      missing.unshift(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) return absPath;
      cursor = parent;
      try {
        const realParent = realpathSync(cursor);
        return resolve(realParent, ...missing);
      } catch {}
    }
  }
}

function getPersonas(ctx: WorkflowCtx): Record<string, PlannerPersona> | null {
  const raw = ctx.config.planner_personas as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => value && typeof value === 'object' && !Array.isArray(value),
  ) as Array<[string, Record<string, unknown>]>;
  if (entries.length === 0) return null;

  const out: Record<string, PlannerPersona> = {};
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
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function getSynthesizer(ctx: WorkflowCtx): PlanSynthesizer | null {
  const raw = ctx.config.plan_synthesizer as Record<string, unknown> | undefined;
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

function sanitizeFileStem(input: string): string {
  const trimmed = input.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'persona';
}

function inlineTopicAndSpec(args: Input, recall: RecallBundle): { topic: string; spec: string } {
  const topic = typeof args.topic === 'string' ? args.topic : '';
  const fileContents = recall.byKey['file.contents'];
  const spec = fileContents && typeof fileContents === 'object' && !Array.isArray(fileContents) && typeof (fileContents as Record<string, unknown>).body === 'string'
    ? String((fileContents as Record<string, unknown>).body)
    : '';
  return { topic, spec };
}

function renderPersonaPrompt(persona: PlannerPersona, args: Input, recall: RecallBundle): string {
  const { topic, spec } = inlineTopicAndSpec(args, recall);
  const specSection = spec.length > 0 ? spec : '(none provided)';

  return `${persona.system_prompt}

## Topic

${topic}

## Spec (if provided)

${specSection}

## Output

Produce a phased TDD plan. Every phase must include failing test -> implementation -> verify. Be concrete about file paths, package boundaries, schema changes, daemon restarts, and any required follow-up checks.`;
}

function synthesisPrompt(
  synth: PlanSynthesizer,
  selected: Array<{ key: string; persona: PlannerPersona }>,
  personaResults: PersonaRunResult[],
): string {
  const sections = selected.map(({ key, persona }) => {
    const result = personaResults.find((r) => r.persona_key === key);
    if (!result) return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: missing result`;
    if (result.status !== 'completed') {
      return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: ${result.error ?? result.status}`;
    }
    return `### ${persona.name} (${persona.bias})\n${result.response_text ?? ''}`;
  });

  return `${synth.system_prompt}

## Plans

${sections.join('\n\n')}

## Synthesis instructions

Identify overlap, conflict, and gaps. Then output one phased TDD plan, followed by a Trade-offs section and an Open questions section. Prefer the smallest defensible plan that still covers real risk and integration hazards.`;
}

function buildSynthesisFrontmatter(args: {
  run_ts: string;
  synthesis_handoff_id: string | null;
  persona_handoff_ids: Record<string, string>;
  topic: string;
  personas: string[];
}): string {
  const lines = [
    '---',
    `run_ts: ${args.run_ts}`,
    `synthesis_handoff_id: ${args.synthesis_handoff_id ?? ''}`,
    `topic: ${args.topic}`,
    `personas: ${args.personas.join(', ')}`,
    'persona_handoff_ids:',
  ];
  for (const [key, id] of Object.entries(args.persona_handoff_ids)) {
    lines.push(`  ${key}: ${id}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

export const fn: WorkflowFn<Input> = async (ctx, recall) => {
  const personasByKey = getPersonas(ctx);
  if (!personasByKey) {
    return {
      ok: false,
      error: 'no_personas_configured',
      hint: 'add planner_personas to ~/.config/agentchat/agentchat.yaml',
    };
  }

  const synthesizer = getSynthesizer(ctx);
  if (!synthesizer) {
    return {
      ok: false,
      error: 'no_synthesizer_configured',
      hint: 'add plan_synthesizer to ~/.config/agentchat/agentchat.yaml',
    };
  }

  const parsedArgs = ctx.args;
  if (
    (typeof parsedArgs.topic !== 'string' || parsedArgs.topic.length === 0) &&
    (typeof parsedArgs.content_path !== 'string' || parsedArgs.content_path.length === 0)
  ) {
    return {
      ok: false,
      error: 'no_topic_or_content',
      hint: 'provide topic or content_path',
    };
  }

  const personaKeys = Object.keys(personasByKey);
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

  const selected = requestedPersonas.map((key) => ({ key, persona: personasByKey[key]! })).filter(Boolean);
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
  const runTs = new Date().toISOString();
  await mkdir(absoluteOutDir, { recursive: true });

  const writePersonaOutputs = async (result: PersonaRunResult): Promise<void> => {
    const stem = sanitizeFileStem(result.persona);
    await ctx.fileWrite(
      join(absoluteOutDir, `${stem}.json`),
      JSON.stringify(
        {
          persona: result.persona,
          status: result.status,
          response_text: result.response_text,
          conversation_id: result.conversation_id,
          handoff_id: result.handoff_id,
          error: result.error,
        },
        null,
        2,
      ),
    );
    await ctx.fileWrite(
      join(absoluteOutDir, `${stem}.md`),
      result.status === 'completed' ? (result.response_text ?? '') : `<dispatch failed: ${result.error ?? result.status}>`,
    );
  };

  const personaResults = await Promise.all(
    requestedPersonas.map(async (key): Promise<PersonaRunResult> => {
      const persona = personasByKey[key]!;
      try {
        const dispatch = await ctx.dispatch({
          agent: persona.preferred_agent,
          message: `cd ${ctx.cwd}\n\n${renderPersonaPrompt(persona, parsedArgs, recall)}`,
          task_type: 'plan_refine',
          use_worktree: false,
        });
        const wait = await ctx.awaitChain(dispatch.conversation_id, { timeoutMs: parsedArgs.timeout_ms });
        const result: PersonaRunResult = {
          persona: persona.name,
          persona_key: key,
          bias: persona.bias,
          status: wait.status,
          response_text: wait.response_text,
          conversation_id: dispatch.conversation_id,
          handoff_id: dispatch.handoff_id,
        };
        await writePersonaOutputs(result);
        return result;
      } catch (err) {
        const result: PersonaRunResult = {
          persona: persona.name,
          persona_key: key,
          bias: persona.bias,
          status: 'failed',
          response_text: null,
          conversation_id: null,
          handoff_id: null,
          error: err instanceof Error ? err.message : String(err),
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
      task_type: 'plan_refine',
      use_worktree: false,
    });
    synthHandoffId = synthDispatch.handoff_id;
    const synthWait = await ctx.awaitChain(synthDispatch.conversation_id, { timeoutMs: parsedArgs.timeout_ms });
    synthStatus = synthWait.status;
    synthesisPath = join(absoluteOutDir, 'synthesis.md');
    const frontmatter = buildSynthesisFrontmatter({
      run_ts: runTs,
      synthesis_handoff_id: synthHandoffId,
      persona_handoff_ids: personaHandoffIds,
      topic: parsedArgs.topic ?? parsedArgs.content_path ?? '',
      personas: selected.map(({ persona }) => persona.name),
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
    const frontmatter = buildSynthesisFrontmatter({
      run_ts: runTs,
      synthesis_handoff_id: synthHandoffId,
      persona_handoff_ids: personaHandoffIds,
      topic: parsedArgs.topic ?? parsedArgs.content_path ?? '',
      personas: selected.map(({ persona }) => persona.name),
    });
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
    })),
    synthesis_path: synthesisPath,
    synthesizer_status: synthStatus,
  };
};

export default spec;
