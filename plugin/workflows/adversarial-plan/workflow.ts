import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowFn, WorkflowSpec, RecallBundle, WorkflowCtx } from "@penumbra/workflows";
import { z } from "zod";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";
import {
  agentPoolToNames,
  parseAgentField,
  resolveAgent,
  type AgentField,
} from "../_shared/pool-resolver.js";

type PlannerPersona = {
  name: string;
  bias: string;
  system_prompt: string;
  preferred_agent: AgentField;
  timeout_ms?: number;
};

type PlanSynthesizer = {
  preferred_agent: AgentField;
  system_prompt: string;
};

type PlanWorkloadConfig = {
  eligible_agents: string[];
  fan_out?: number;
  synthesizer?: unknown;
};

type PersonaResolution =
  | { ok: true; personas: Record<string, PlannerPersona> }
  | {
      ok: false;
      error: "unknown_persona";
      missing_persona: string;
      workload: "plan_refine";
      hint: string;
    };

export const inputSchema = z
  .object({
    topic: z.string().optional(),
    content_path: z.string().optional(),
    personas: z.array(z.string().min(1)).optional(),
    focus: z.string().min(1).max(2000).optional(),
    timeout_ms: z.number().int().positive().default(1800000),
    out_dir: z.string().optional(),
  })
  .strict();

export type Input = z.infer<typeof inputSchema>;

type PersonaRunResult = {
  persona: string;
  persona_key: string;
  bias: string;
  status: "completed" | "failed" | "timeout";
  response_text: string | null;
  conversation_id: string | null;
  handoff_id: string | null;
  error?: string;
  retry_count?: 1;
};

const RETRY_BACKOFF_MS = 5000;

function shouldRetryWorkerUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /no_worker_registered/i.test(message) ||
    /worker_heartbeats_stale/i.test(message) ||
    /503/.test(message)
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function dedupePersonas(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

const spec: WorkflowSpec = {
  name: "adversarial-plan",
  description:
    "Fan out a planning topic across N planner personas with distinct biases; synthesize a phased TDD plan.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "adversarial-plan" }],
  recall: [{ source: "file.contents", args: { path: "{{args.content_path}}" } }],
  recall_budget_tokens: 12000,
  output: [],
  run: { kind: "ts-function" },
};

function getPlanWorkload(ctx: WorkflowCtx): PlanWorkloadConfig | null {
  const workloads = ctx.config.workloads;
  if (!workloads || typeof workloads !== "object" || Array.isArray(workloads)) return null;
  const raw = (workloads as Record<string, unknown>).plan_refine;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const eligibleAgents = Array.isArray(row.eligible_agents)
    ? row.eligible_agents.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const fanOut =
    Number.isInteger(row.fan_out) && (row.fan_out as number) > 0
      ? (row.fan_out as number)
      : undefined;
  const synthesizer = agentPoolToNames(row.synthesizer).length > 0 ? row.synthesizer : undefined;
  return {
    eligible_agents: eligibleAgents,
    fan_out: fanOut,
    synthesizer,
  };
}

function getConfiguredPersonas(ctx: WorkflowCtx): Record<string, PlannerPersona> {
  const raw = ctx.config.personas;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => value && typeof value === "object" && !Array.isArray(value),
  ) as Array<[string, Record<string, unknown>]>;
  const out: Record<string, PlannerPersona> = {};
  for (const [key, value] of entries) {
    const preferredAgent = parseAgentField(value.preferred_agent);
    if (
      !preferredAgent ||
      typeof value.bias !== "string" ||
      value.bias.length === 0 ||
      typeof value.system_prompt !== "string" ||
      value.system_prompt.length === 0
    ) {
      continue;
    }
    out[key] = {
      name: key,
      preferred_agent: preferredAgent,
      bias: value.bias,
      system_prompt: value.system_prompt,
      timeout_ms:
        Number.isInteger(value.timeout_ms) && (value.timeout_ms as number) > 0
          ? (value.timeout_ms as number)
          : undefined,
    };
  }
  return out;
}

function getPersonas(ctx: WorkflowCtx): PersonaResolution | null {
  const workload = getPlanWorkload(ctx);
  if (!workload) return null;
  const eligibleAgents = workload.fan_out
    ? workload.eligible_agents.slice(0, workload.fan_out)
    : workload.eligible_agents;
  if (eligibleAgents.length === 0) return null;

  const configured = getConfiguredPersonas(ctx);
  const resolved: Record<string, PlannerPersona> = {};
  for (const personaKey of eligibleAgents) {
    const persona = configured[personaKey];
    if (!persona) {
      return {
        ok: false,
        error: "unknown_persona",
        missing_persona: personaKey,
        workload: "plan_refine",
        hint: `add personas.${personaKey} to routing.yaml`,
      };
    }
    resolved[personaKey] = persona;
  }
  return { ok: true, personas: resolved };
}

function getSynthesizer(ctx: WorkflowCtx): PlanSynthesizer | null {
  const workload = getPlanWorkload(ctx);
  if (!workload || !workload.synthesizer) return null;
  const field = parseAgentField(workload.synthesizer);
  if (!field) return null;
  return {
    preferred_agent: field,
    system_prompt: "You are merging N planner outputs into one prioritized phased TDD plan.",
  };
}

function inlineTopicAndSpec(args: Input, recall: RecallBundle): { topic: string; spec: string } {
  const topic = typeof args.topic === "string" ? args.topic : "";
  const fileContents = recall.byKey["file.contents"];
  const spec =
    fileContents &&
    typeof fileContents === "object" &&
    !Array.isArray(fileContents) &&
    typeof (fileContents as Record<string, unknown>).body === "string"
      ? String((fileContents as Record<string, unknown>).body)
      : "";
  return { topic, spec };
}

function renderPersonaPrompt(persona: PlannerPersona, args: Input, recall: RecallBundle): string {
  const { topic, spec } = inlineTopicAndSpec(args, recall);
  const specSection = spec.length > 0 ? spec : "(none provided)";
  const focusSection =
    typeof args.focus === "string" && args.focus.length > 0
      ? `## Caller's focus\n\n${args.focus}\n\n`
      : "";

  return `${persona.system_prompt}

## Topic

${topic}

${focusSection}## Spec (if provided)

${specSection}

## Output

Produce a phased TDD plan. Every phase must include failing test -> implementation -> verify. Be concrete about file paths, package boundaries, schema changes, daemon restarts, and any required follow-up checks.`;
}

function synthesisPrompt(
  synth: PlanSynthesizer,
  selected: Array<{ key: string; persona: PlannerPersona }>,
  personaResults: PersonaRunResult[],
  args: Input,
): string {
  const sections = selected.map(({ key, persona }) => {
    const result = personaResults.find((r) => r.persona_key === key);
    if (!result) return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: missing result`;
    if (result.status !== "completed") {
      return `### ${persona.name} (${persona.bias})\nDISPATCH FAILED: ${result.error ?? result.status}`;
    }
    return `### ${persona.name} (${persona.bias})\n${result.response_text ?? ""}`;
  });

  const focusPrefix =
    typeof args.focus === "string" && args.focus.length > 0
      ? `Caller focus: ${args.focus}\n\n`
      : "";

  return `You are the synthesizer for an /adversarial-plan fan-out. This is NOT a session start.
Do not run first moves. Do not check git status. Do not query handoff_list_pending.
Do not output status summaries, daemon / worker PID lines, or tables. Your only job is to
merge the planner outputs below into one prioritized phased TDD plan. Output the merged plan
as your entire response.

---

${synth.system_prompt}

---

${focusPrefix}## Plans

${sections.join("\n\n")}

## Synthesis instructions

Identify overlap, conflict, and gaps. Then output one phased TDD plan, followed by a Trade-offs section and an Open questions section. Prefer the smallest defensible plan that still covers real risk and integration hazards.`;
}

function buildSynthesisFrontmatter(args: {
  run_ts: string;
  synthesis_handoff_id: string | null;
  persona_handoff_ids: Record<string, string>;
  topic: string;
  personas: string[];
  synthesizer_agent: string;
}): string {
  const lines = [
    "---",
    `run_ts: ${args.run_ts}`,
    `synthesis_handoff_id: ${args.synthesis_handoff_id ?? ""}`,
    `synthesizer_agent: ${args.synthesizer_agent}`,
    `topic: ${args.topic}`,
    `personas: ${args.personas.join(", ")}`,
    "persona_handoff_ids:",
  ];
  for (const [key, id] of Object.entries(args.persona_handoff_ids)) {
    lines.push(`  ${key}: ${id}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n\n";
}

export const fn: WorkflowFn<Input> = async (ctx, recall) => {
  const personaResolution = getPersonas(ctx);
  if (!personaResolution) {
    return {
      ok: false,
      error: "no_personas_configured",
      hint: "add workloads.plan_refine.eligible_agents to ~/.config/penumbra/routing.yaml",
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
      hint: "add workloads.plan_refine.synthesizer to ~/.config/penumbra/routing.yaml",
    };
  }

  const parsedArgs = ctx.args;
  if (
    (typeof parsedArgs.topic !== "string" || parsedArgs.topic.length === 0) &&
    (typeof parsedArgs.content_path !== "string" || parsedArgs.content_path.length === 0)
  ) {
    return {
      ok: false,
      error: "no_topic_or_content",
      hint: "provide topic or content_path",
    };
  }

  const personaKeys = Object.keys(personasByKey);
  const requestedPersonas = dedupePersonas(parsedArgs.personas ?? personaKeys);
  const missing = requestedPersonas.filter((name) => !personasByKey[name]);
  if (missing.length > 0) {
    return {
      ok: false,
      error: "unknown_personas",
      missing_personas: missing,
      hint: `available personas: ${personaKeys.join(", ")}`,
    };
  }

  const selected = requestedPersonas
    .map((key) => ({ key, persona: personasByKey[key]! }))
    .filter(Boolean);
  if (selected.length === 0) {
    return {
      ok: false,
      error: "no_personas_selected",
      hint: `available personas: ${personaKeys.join(", ")}`,
    };
  }
  // tool_free:true — plan-refine synthesizer dispatch is pure text generation:
  // it receives N planner outputs inlined in the prompt and emits a merged plan
  // as response_text. No penumbra MCP tools, no worktree, no commit.
  const synthAgent = resolveAgent(synthesizer.preferred_agent, "plan_refine", ctx, {
    fallback_role: "planner",
    tool_free: true,
  });

  const outDirResolution = resolveOutDir(ctx, parsedArgs.out_dir);
  if (!outDirResolution.ok) {
    return {
      ok: false,
      error: "out_dir_outside_allowed_roots",
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
          retry_count: result.retry_count,
        },
        null,
        2,
      ),
    );
    await ctx.fileWrite(
      join(absoluteOutDir, `${stem}.md`),
      result.status === "completed"
        ? (result.response_text ?? "")
        : `<dispatch failed: ${result.error ?? result.status}>`,
    );
  };

  const personaResults = await Promise.all(
    requestedPersonas.map(async (key): Promise<PersonaRunResult> => {
      const persona = personasByKey[key]!;
      let retryCount: 0 | 1 = 0;
      try {
        let dispatch: { conversation_id: string; handoff_id: string };
        let wait: { status: "completed" | "failed" | "timeout"; response_text: string | null };
        // tool_free:true — planner persona dispatch is pure text generation:
        // it receives topic + spec inlined in the prompt and emits a phased
        // plan as response_text. No penumbra MCP tools, no worktree, no commit.
        const personaAgent = resolveAgent(persona.preferred_agent, "plan_refine", ctx, {
          fallback_role: "planner",
          tool_free: true,
        });
        while (true) {
          try {
            dispatch = await ctx.dispatch({
              agent: personaAgent,
              message: `cd ${ctx.cwd}\n\n${renderPersonaPrompt(persona, parsedArgs, recall)}`,
              task_type: "plan_refine",
              use_worktree: false,
              task_class: "TRIVIAL",
            });
            const timeoutMs = persona.timeout_ms ?? parsedArgs.timeout_ms;
            wait = await ctx.awaitChain(dispatch.conversation_id, { timeoutMs });
            break;
          } catch (err) {
            if (retryCount < 1 && shouldRetryWorkerUnavailable(err)) {
              retryCount = 1;
              await sleep(RETRY_BACKOFF_MS);
              continue;
            }
            throw err;
          }
        }
        const result: PersonaRunResult = {
          persona: persona.name,
          persona_key: key,
          bias: persona.bias,
          status: wait.status,
          response_text: wait.response_text,
          conversation_id: dispatch.conversation_id,
          handoff_id: dispatch.handoff_id,
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
          response_text: null,
          conversation_id: null,
          handoff_id: null,
          error: err instanceof Error ? err.message : String(err),
          retry_count: retryCount === 1 ? 1 : undefined,
        };
        await writePersonaOutputs(result);
        return result;
      }
    }),
  );

  const completedResults = personaResults.filter(
    (result) =>
      result.status === "completed" &&
      typeof result.response_text === "string" &&
      result.response_text.length > 0,
  );
  const failedPersonas = personaResults
    .filter((result) => result.status !== "completed")
    .map((result) => result.persona);
  const outcome = failedPersonas.length === 0 ? "success" : "failed";

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
    wait: { status: "completed" | "failed" | "timeout"; response_text: string | null };
  }> => {
    let attempts = 0;
    while (true) {
      try {
        const dispatch = await ctx.dispatch({
          agent: synthAgent,
          message: `cd ${ctx.cwd}\n\n${synthesisPrompt(synthesizer, selected, personaResults, parsedArgs)}`,
          task_type: "plan_refine",
          use_worktree: false,
          task_class: "TRIVIAL",
        });
        const wait = await ctx.awaitChain(dispatch.conversation_id, {
          timeoutMs: parsedArgs.timeout_ms,
        });
        return { dispatch, wait };
      } catch (err) {
        if (attempts < 1 && shouldRetryWorkerUnavailable(err)) {
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
      ? "> Synthesizer retried once after 503 no_worker_registered or worker_heartbeats_stale\n\n"
      : "";
    synthHandoffId = synthDispatch.handoff_id;
    synthStatus = synthWait.status;
    synthesisPath = join(absoluteOutDir, "synthesis.md");
    const frontmatter = buildSynthesisFrontmatter({
      run_ts: runTs,
      synthesis_handoff_id: synthHandoffId,
      persona_handoff_ids: personaHandoffIds,
      topic: parsedArgs.topic ?? parsedArgs.content_path ?? "",
      personas: selected.map(({ persona }) => persona.name),
      synthesizer_agent: synthAgent,
    });
    await ctx.fileWrite(
      synthesisPath,
      synthRetryBanner +
        (synthWait.status === "completed"
          ? frontmatter + (synthWait.response_text ?? "")
          : frontmatter + `<synthesizer failed: ${synthWait.status}>`),
    );
  } catch (err) {
    const synthRetryBanner = synthRetryUsed
      ? "> Synthesizer retried once after 503 no_worker_registered or worker_heartbeats_stale\n\n"
      : "";
    synthStatus = "failed";
    synthesisPath = join(absoluteOutDir, "synthesis.md");
    const frontmatter = buildSynthesisFrontmatter({
      run_ts: runTs,
      synthesis_handoff_id: synthHandoffId,
      persona_handoff_ids: personaHandoffIds,
      topic: parsedArgs.topic ?? parsedArgs.content_path ?? "",
      personas: selected.map(({ persona }) => persona.name),
      synthesizer_agent: synthAgent,
    });
    await ctx.fileWrite(
      synthesisPath,
      synthRetryBanner +
        frontmatter +
        `<synthesizer failed: ${err instanceof Error ? err.message : String(err)}>`,
    );
  }

  return {
    ok: outcome !== "failed" && synthStatus === "completed",
    outcome,
    failed_personas: failedPersonas,
    completed_personas: personaResults
      .filter((result) => result.status === "completed")
      .map((result) => result.persona),
    out_dir: absoluteOutDir,
    personas: personaResults.map((result) => ({
      name: result.persona,
      status: result.status,
      conversation_id: result.conversation_id,
    })),
    synthesis_path: synthesisPath,
    synthesizer_status: synthStatus,
    synth_failed: synthStatus !== "completed",
  };
};

export default spec;
