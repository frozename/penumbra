import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowFn, WorkflowSpec, RecallBundle, WorkflowCtx } from "@penumbra/workflows";
import { z } from "zod";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";

type ReviewPersona = {
  name: string;
  bias: string;
  system_prompt: string;
  preferred_agent: string;
  category_hints?: string[];
  timeout_ms?: number;
};

type ReviewSynthesizer = {
  preferred_agent: string;
  system_prompt: string;
};

type ReviewWorkloadConfig = {
  eligible_agents: string[];
  fan_out?: number;
  synthesizer?: string;
};

type PersonaResolution =
  | { ok: true; personas: Record<string, ReviewPersona> }
  | {
      ok: false;
      error: "unknown_persona";
      missing_persona: string;
      workload: "review_adversarial";
      hint: string;
    };

export const inputSchema = z
  .object({
    target_ref: z.string().default("HEAD"),
    base_ref: z.string().default("main"),
    personas: z.array(z.string().min(1)).optional(),
    content_path: z.string().optional(),
    focus: z.string().min(1).max(2000).optional(),
    timeout_ms: z.number().int().positive().default(1200000),
    out_dir: z.string().optional(),
  })
  .strict();

export type Input = z.infer<typeof inputSchema>;

const TRIVIAL_RESPONSE_THRESHOLD = 200;

type PersonaRunResult = {
  persona: string;
  persona_key: string;
  bias: string;
  status: "completed" | "failed" | "timeout";
  raw_status: "completed" | "failed" | "timeout";
  response_text: string | null;
  conversation_id: string | null;
  handoff_id: string | null;
  error?: string;
  findings: unknown[] | null;
  parse_error?: "no_json_block" | "invalid_json";
  triviality_reason?: "trivial_response" | "no_findings";
  retry_count?: 1;
};

const RETRY_BACKOFF_MS = 5000;

function shouldRetryNoWorkerRegistered(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no_worker_registered/i.test(message) || /503/.test(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const spec: WorkflowSpec = {
  name: "adversarial-review",
  description:
    "Fan out a code review across N reviewer personas with distinct biases; synthesize findings.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "adversarial-review" }],
  recall: [
    { source: "git.diff", args: { range: "{{args.base_ref}}...{{args.target_ref}}" } },
    {
      source: "git.show",
      args: { range: "{{args.base_ref}}..{{args.target_ref}}", max_commits: 20 },
    },
    { source: "file.contents", args: { path: "{{args.content_path}}" } },
  ],
  recall_budget_tokens: 24000,
  output: [],
  run: { kind: "ts-function" },
};

function getReviewWorkload(ctx: WorkflowCtx): ReviewWorkloadConfig | null {
  const workloads = ctx.config.workloads;
  if (!workloads || typeof workloads !== "object" || Array.isArray(workloads)) return null;
  const raw = (workloads as Record<string, unknown>).review_adversarial;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const eligibleAgents = Array.isArray(row.eligible_agents)
    ? row.eligible_agents.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const fanOut =
    Number.isInteger(row.fan_out) && (row.fan_out as number) > 0
      ? (row.fan_out as number)
      : undefined;
  const synthesizer =
    typeof row.synthesizer === "string" && row.synthesizer.length > 0 ? row.synthesizer : undefined;
  return {
    eligible_agents: eligibleAgents,
    fan_out: fanOut,
    synthesizer,
  };
}

function getConfiguredPersonas(ctx: WorkflowCtx): Record<string, ReviewPersona> {
  const raw = ctx.config.personas;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => value && typeof value === "object" && !Array.isArray(value),
  ) as Array<[string, Record<string, unknown>]>;
  const out: Record<string, ReviewPersona> = {};
  for (const [key, value] of entries) {
    if (
      typeof value.preferred_agent !== "string" ||
      value.preferred_agent.length === 0 ||
      typeof value.bias !== "string" ||
      value.bias.length === 0 ||
      typeof value.system_prompt !== "string" ||
      value.system_prompt.length === 0
    ) {
      continue;
    }
    out[key] = {
      name: key,
      preferred_agent: value.preferred_agent,
      bias: value.bias,
      system_prompt: value.system_prompt,
      timeout_ms:
        Number.isInteger(value.timeout_ms) && (value.timeout_ms as number) > 0
          ? (value.timeout_ms as number)
          : undefined,
      category_hints: Array.isArray(value.category_hints)
        ? value.category_hints.filter((x): x is string => typeof x === "string" && x.length > 0)
        : undefined,
    };
  }
  return out;
}

function getPersonas(ctx: WorkflowCtx): PersonaResolution | null {
  const workload = getReviewWorkload(ctx);
  if (!workload) return null;
  const eligibleAgents = workload.fan_out
    ? workload.eligible_agents.slice(0, workload.fan_out)
    : workload.eligible_agents;
  if (eligibleAgents.length === 0) return null;

  const configured = getConfiguredPersonas(ctx);
  const resolved: Record<string, ReviewPersona> = {};
  for (const personaKey of eligibleAgents) {
    const persona = configured[personaKey];
    if (!persona) {
      return {
        ok: false,
        error: "unknown_persona",
        missing_persona: personaKey,
        workload: "review_adversarial",
        hint: `add personas.${personaKey} to routing.yaml`,
      };
    }
    resolved[personaKey] = persona;
  }

  return { ok: true, personas: resolved };
}

function getSynthesizer(ctx: WorkflowCtx): ReviewSynthesizer | null {
  const workload = getReviewWorkload(ctx);
  if (!workload || !workload.synthesizer) return null;
  return {
    preferred_agent: workload.synthesizer,
    system_prompt: "Synthesize adversarial reviewer outputs into one prioritized findings list.",
  };
}

function formatGitShow(recall: RecallBundle): string {
  const commits = recall.byKey["git.show"];
  if (!Array.isArray(commits) || commits.length === 0) return "(none)";
  return commits
    .map((commit) => {
      if (!commit || typeof commit !== "object") return null;
      const row = commit as Record<string, unknown>;
      const sha = typeof row.sha === "string" ? row.sha : "";
      const subject = typeof row.subject === "string" ? row.subject : "";
      const ts = typeof row.ts === "string" ? row.ts : "";
      const body = typeof row.body === "string" ? row.body : "";
      return `- ${sha} ${subject} (${ts})\n${body}`.trim();
    })
    .filter((x): x is string => Boolean(x))
    .join("\n\n");
}

function fileContentsBody(recall: RecallBundle): string {
  const fileContents = recall.byKey["file.contents"];
  if (!fileContents || typeof fileContents !== "object" || Array.isArray(fileContents)) return "";
  const body = (fileContents as Record<string, unknown>).body;
  return typeof body === "string" ? body : "";
}

function renderPersonaPrompt(persona: ReviewPersona, recall: RecallBundle, args: Input): string {
  const gitDiff =
    typeof recall.byKey["git.diff"] === "string" ? (recall.byKey["git.diff"] as string) : "";
  const commits = formatGitShow(recall);
  const content = fileContentsBody(recall);
  const categoryHints =
    persona.category_hints && persona.category_hints.length > 0
      ? persona.category_hints.join(", ")
      : "any";

  // When content_path is passed, the file body is the authoritative diff to review.
  // git.diff and git.show recall fetched from the workflow's cwd, which can be the
  // daemon's cwd (penumbra) rather than the target repo — drop the misleading
  // sections to prevent personas from reviewing the wrong thing.
  const useContent =
    typeof args.content_path === "string" && args.content_path.length > 0 && content.length > 0;
  const diffBody = useContent ? content : gitDiff;
  const reviewTarget = useContent
    ? `content_path=${args.content_path}\nbase_ref=${args.base_ref}\ntarget_ref=${args.target_ref}\n\nThe Diff section below comes from the explicit content_path file — this is the authoritative review target. Ignore any git context from your worktree.`
    : `base_ref=${args.base_ref}\ntarget_ref=${args.target_ref}`;
  const focusSection =
    typeof args.focus === "string" && args.focus.length > 0
      ? `\n## Caller's focus\n${args.focus}\n`
      : "";
  const commitsSection = useContent ? "" : `\n## Recent commits\n${commits}\n`;

  const contentModePreamble = useContent
    ? `**Content-mode review** — The target below is a prose document, not a code diff.
The DOCUMENT'S structure (numbering, evidence schema, scope, time anchors, prose
quality) is **out of scope** for this review. Your job is to engage with the
underlying problems the document describes, through your persona lens. If the
document lists problems, evaluate which are real and how to prioritize them.
If the document proposes a direction, evaluate that direction. Critique the
substance, not the document.

`
    : "";

  return `You are reviewing code as a ${persona.bias} reviewer.

${contentModePreamble}${persona.system_prompt}

## Review Target
${reviewTarget}
${focusSection}
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
  parse_error?: "no_json_block" | "invalid_json";
} {
  if (!responseText || responseText.length === 0)
    return { findings: null, parse_error: "no_json_block" };
  const pattern = /```json\s*([\s\S]*?)```/gi;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(responseText))) {
    last = match[1] ?? "";
  }
  if (last === null) return { findings: null, parse_error: "no_json_block" };
  try {
    const parsed = JSON.parse(last);
    if (!Array.isArray(parsed)) return { findings: null, parse_error: "invalid_json" };
    return { findings: parsed };
  } catch {
    return { findings: null, parse_error: "invalid_json" };
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

function resolveRequestedPersonas(
  requested: string[],
  availableKeys: string[],
): {
  resolved: string[];
  missing: string[];
  warnings: string[];
} {
  const resolved: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  for (const requestedName of requested) {
    if (availableKeys.includes(requestedName)) {
      resolved.push(requestedName);
      continue;
    }

    const ranked = availableKeys
      .map((candidate) => ({
        candidate,
        distance: levenshtein(requestedName.toLowerCase(), candidate.toLowerCase()),
      }))
      .filter((entry) => entry.distance <= 3)
      .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
    if (ranked.length === 0) {
      missing.push(requestedName);
      continue;
    }

    const bestDistance = ranked[0]!.distance;
    const best = ranked.filter((entry) => entry.distance === bestDistance);
    if (best.length !== 1) {
      missing.push(requestedName);
      continue;
    }

    const matched = best[0]!.candidate;
    resolved.push(matched);
    warnings.push(`resolved '${requestedName}' to '${matched}'`);
  }
  return { resolved, missing, warnings };
}

function isTrivialResponse(text: string | null): boolean {
  return !text || text.trim().length < TRIVIAL_RESPONSE_THRESHOLD;
}

function synthesisPrompt(
  synth: ReviewSynthesizer,
  selected: ReviewPersona[],
  personaResults: PersonaRunResult[],
  args: Input,
): string {
  const sections = selected.map((persona) => {
    const result = personaResults.find((r) => r.persona === persona.name);
    if (!result) return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: missing result`;
    if (result.status !== "completed") {
      return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: ${result.triviality_reason ?? result.error ?? result.status}`;
    }
    return `### ${persona.name} (${persona.bias})\n${result.response_text ?? ""}`;
  });

  const focusPrefix =
    typeof args.focus === "string" && args.focus.length > 0
      ? `Caller focus: ${args.focus}\n\n`
      : "";

  return `${synth.system_prompt}

You are synthesizing ${selected.length} adversarial reviews. Each persona reviewed the same diff with a different lens.

${focusPrefix}## Reviews
${sections.join("\n\n")}

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
    "---",
    `review_run_ts: ${args.review_run_ts}`,
    `synthesis_handoff_id: ${args.synthesis_handoff_id}`,
    "persona_handoff_ids:",
  ];
  for (const [key, id] of Object.entries(args.persona_handoff_ids)) {
    lines.push(`  ${key}: ${id}`);
  }
  lines.push(`target_ref: ${args.target_ref}`);
  lines.push(`base_ref: ${args.base_ref}`);
  lines.push("---");
  return lines.join("\n") + "\n\n";
}

export const fn: WorkflowFn<Input> = async (ctx, recall) => {
  const personaResolution = getPersonas(ctx);
  if (!personaResolution) {
    return {
      ok: false,
      error: "no_personas_configured",
      hint: "add workloads.review_adversarial.eligible_agents to ~/.config/penumbra/routing.yaml",
    };
  }
  if (!personaResolution.ok) {
    return {
      ok: false,
      error: personaResolution.error,
      missing_persona: personaResolution.missing_persona,
      workload: personaResolution.workload,
      hint: personaResolution.hint,
    };
  }
  const personasByKey = personaResolution.personas;

  const synthesizer = getSynthesizer(ctx);
  if (!synthesizer) {
    return {
      ok: false,
      error: "no_synthesizer_configured",
      hint: "add workloads.review_adversarial.synthesizer to ~/.config/penumbra/routing.yaml",
    };
  }

  const personaKeys = Object.keys(personasByKey);
  const parsedArgs = ctx.args;
  const requestedPersonas = parsedArgs.personas ?? personaKeys;
  const resolvedPersonas = resolveRequestedPersonas(requestedPersonas, personaKeys);
  const missing = resolvedPersonas.missing;
  if (missing.length > 0) {
    return {
      ok: false,
      error: "unknown_personas",
      missing_personas: missing,
      hint: `available personas: ${personaKeys.join(", ")}`,
    };
  }
  const selected = resolvedPersonas.resolved.map((key) => personasByKey[key]!).filter(Boolean);
  if (selected.length === 0) {
    return {
      ok: false,
      error: "no_personas_selected",
      hint: `available personas: ${personaKeys.join(", ")}`,
    };
  }

  const outDirResolution = resolveOutDir(ctx, parsedArgs.out_dir);
  if (!outDirResolution.ok) {
    return {
      ok: false,
      error: "out_dir_outside_allowed_roots",
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
          retry_count: result.retry_count,
        },
        null,
        2,
      ),
    );
    const mdBody =
      result.status === "completed"
        ? (result.response_text ?? "")
        : `<dispatch failed: ${result.error ?? result.status}>`;
    await ctx.fileWrite(mdPath, mdBody);
  };

  const personaResults = await Promise.all(
    resolvedPersonas.resolved.map(async (key): Promise<PersonaRunResult> => {
      const persona = personasByKey[key]!;
      let retryCount: 0 | 1 = 0;
      try {
        let dispatch: { conversation_id: string; handoff_id: string };
        let wait: {
          status: "completed" | "failed" | "timeout";
          final_agent: string | null;
          response_text: string | null;
        };
        while (true) {
          try {
            dispatch = await ctx.dispatch({
              agent: persona.preferred_agent,
              message: `cd ${ctx.cwd}\n\n${renderPersonaPrompt(persona, recall, parsedArgs)}`,
              task_type: "review_adversarial",
              use_worktree: false,
            });
            const timeoutMs = persona.timeout_ms ?? parsedArgs.timeout_ms;
            wait = await ctx.awaitChain(dispatch.conversation_id, { timeoutMs });
            break;
          } catch (err) {
            if (retryCount < 1 && shouldRetryNoWorkerRegistered(err)) {
              retryCount = 1;
              await sleep(RETRY_BACKOFF_MS);
              continue;
            }
            throw err;
          }
        }
        const parsed = parseFindingsJson(wait.response_text);
        let effectiveStatus = wait.status;
        let trivialityReason: PersonaRunResult["triviality_reason"];
        if (
          effectiveStatus === "completed" &&
          isTrivialResponse(wait.response_text) &&
          parsed.findings === null
        ) {
          effectiveStatus = "failed";
          trivialityReason = "trivial_response";
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
          retry_count: retryCount === 1 ? 1 : undefined,
        };
        await writePersonaOutputs(result);
        return result;
      } catch (err) {
        const result: PersonaRunResult = {
          persona: persona.name,
          persona_key: key,
          bias: persona.bias,
          status: "failed",
          raw_status: "failed",
          response_text: null,
          conversation_id: null,
          handoff_id: null,
          error: err instanceof Error ? err.message : String(err),
          findings: null,
          retry_count: retryCount === 1 ? 1 : undefined,
        };
        await writePersonaOutputs(result);
        return result;
      }
    }),
  );

  const completedCount = personaResults.filter((r) => r.status === "completed").length;
  const failedCount = personaResults.length - completedCount;
  const failedPersonas = personaResults
    .filter((r) => r.status !== "completed")
    .map((r) => r.persona);
  const passPct = (completedCount / personaResults.length) * 100;
  const minPassPct = (ctx.config.review_min_personas_pass_pct as number | undefined) ?? 80;
  let outcome: "success" | "success_partial" | "failed";
  if (failedCount === 0) outcome = "success";
  else if (passPct < minPassPct) outcome = "failed";
  else outcome = "success_partial";
  const partialBanner =
    failedCount > 0
      ? `> Partial review: ${completedCount} of ${personaResults.length} personas completed (failed: ${failedPersonas.join(", ")})\n\n`
      : "";

  const completedResults = personaResults.filter(
    (result) =>
      result.status === "completed" &&
      typeof result.response_text === "string" &&
      result.response_text.length > 0,
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
      error: "all_persona_dispatches_failed",
      hint: "all persona dispatches failed or timed out",
    };
  }

  let synthesisPath: string | null = null;
  let synthStatus: "completed" | "failed" | "timeout" | null = null;
  let synthHandoffId: string | null = null;
  let synthRetryUsed = false;
  const personaHandoffIds: Record<string, string> = {};
  for (const r of personaResults) {
    if (r.handoff_id) {
      personaHandoffIds[r.persona_key] = r.handoff_id;
    }
  }
  const dispatchSynth = async (): Promise<{
    dispatch: { conversation_id: string; handoff_id: string };
    wait: {
      status: "completed" | "failed" | "timeout";
      final_agent: string | null;
      response_text: string | null;
    };
  }> => {
    let attempts = 0;
    while (true) {
      try {
        const dispatch = await ctx.dispatch({
          agent: synthesizer.preferred_agent,
          message: `cd ${ctx.cwd}\n\n${synthesisPrompt(synthesizer, selected, personaResults, parsedArgs)}`,
          task_type: "review_adversarial",
          use_worktree: false,
        });
        const wait = await ctx.awaitChain(dispatch.conversation_id, {
          timeoutMs: parsedArgs.timeout_ms,
        });
        return { dispatch, wait };
      } catch (err) {
        if (attempts < 1 && shouldRetryNoWorkerRegistered(err)) {
          attempts += 1;
          synthRetryUsed = true;
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        throw err;
      }
    }
  };

  try {
    const { dispatch: synthDispatch, wait: synthWait } = await dispatchSynth();
    const synthRetryBanner = synthRetryUsed
      ? "> Synthesizer retried once after 503 no_worker_registered\n\n"
      : "";
    synthHandoffId = synthDispatch.handoff_id;
    synthStatus = synthWait.status;
    synthesisPath = join(absoluteOutDir, "synthesis.md");
    const frontmatter = buildSynthesisFrontmatter({
      review_run_ts: reviewRunTs,
      synthesis_handoff_id: synthHandoffId,
      persona_handoff_ids: personaHandoffIds,
      target_ref: parsedArgs.target_ref,
      base_ref: parsedArgs.base_ref,
    });
    await ctx.fileWrite(
      synthesisPath,
      synthRetryBanner +
        partialBanner +
        (synthWait.status === "completed"
          ? frontmatter + (synthWait.response_text ?? "")
          : frontmatter + `<synthesizer failed: ${synthWait.status}>`),
    );
  } catch (err) {
    const synthRetryBanner = synthRetryUsed
      ? "> Synthesizer retried once after 503 no_worker_registered\n\n"
      : "";
    synthStatus = "failed";
    synthesisPath = join(absoluteOutDir, "synthesis.md");
    const frontmatter = synthHandoffId
      ? buildSynthesisFrontmatter({
          review_run_ts: reviewRunTs,
          synthesis_handoff_id: synthHandoffId,
          persona_handoff_ids: personaHandoffIds,
          target_ref: parsedArgs.target_ref,
          base_ref: parsedArgs.base_ref,
        })
      : "";
    await ctx.fileWrite(
      synthesisPath,
      synthRetryBanner +
        partialBanner +
        frontmatter +
        `<synthesizer failed: ${err instanceof Error ? err.message : String(err)}>`,
    );
  }

  return {
    ok: outcome !== "failed",
    outcome,
    ...(resolvedPersonas.warnings.length > 0 ? { warnings: resolvedPersonas.warnings } : {}),
    failed_personas: failedPersonas,
    completed_personas: personaResults
      .filter((r) => r.status === "completed")
      .map((r) => r.persona),
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
