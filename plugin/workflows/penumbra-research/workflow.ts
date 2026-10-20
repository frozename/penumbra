import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { join } from "node:path";
import { z } from "zod";

import { type FanoutCtx, type FanoutDefaults, runFanout } from "../_shared/fanout.js";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";
import { parseStructured } from "../_shared/structured.js";
import { type MemoryPrime, primeFromMemory } from "./memory-prime.js";
import {
  boundSummary,
  buildPlannerPrompt,
  buildResearchPrompt,
  buildSynthesisPrompt,
  type FindingResult,
  FindingSchema,
  findingsExcerpt,
  isSubquestionMatch,
  type PlannerResult,
  PlannerSchema,
  RESEARCH_SOURCE_BOUNDS,
  SYNTHESIS_SOURCE_BOUNDS,
  type SynthesisResult,
  SynthesisSchema,
  validatePlannerSubquestions,
  validateSourceUrls,
} from "./research-contract.js";
import { resolveWebSeat } from "./web-seat.js";

export const inputSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    angles: z.number().int().min(1).max(6).default(4),
    web_agent: z.string().min(1).max(120).optional(),
    planner_agent: z.string().min(1).max(120).default("executor"),
    synthesis_agent: z.string().min(1).max(120).default("executor"),
    persist: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(1_800_000),
    out_dir: z.string().min(1).max(500).default("research"),
    project_id: z.string().min(1).max(120).optional(),
  })
  .strict();

export type Input = z.infer<typeof inputSchema>;

export type FindingSummary = {
  subquestion: string;
  sources: string[];
  findings_excerpt: string;
};

export type MemoryCandidate = {
  question: string;
  summary: string;
  source_urls: string[];
  report_path: string;
};

export type ResearchResult = {
  ok: boolean;
  error?: string;
  question: string;
  prior_brief: string | null;
  subquestions: string[];
  angles_requested: number;
  angles_valid: number;
  findings: FindingSummary[];
  sources: string[];
  summary: string | null;
  report_path: string | null;
  persisted: false;
  persistence_reason: "no_native_t2_write_path" | null;
  memory_candidate: MemoryCandidate | null;
};

const REPORT_FILENAME = "report.md";

function fanoutDefaults(projectId: string, timeoutMs: number): FanoutDefaults {
  return {
    project_id: projectId,
    timeout_ms: timeoutMs,
    task_class: "STANDARD",
    trust_mode: "all",
    max_hops: 1,
    use_worktree: false,
  };
}

function failedResult(
  input: Input,
  prime: MemoryPrime,
  error: string,
  extras: Partial<ResearchResult> = {},
): ResearchResult {
  return {
    ok: false,
    error,
    question: input.question,
    prior_brief: prime.brief.length > 0 ? prime.brief : null,
    subquestions: [],
    angles_requested: input.angles,
    angles_valid: 0,
    findings: [],
    sources: [],
    summary: null,
    report_path: null,
    persisted: false,
    persistence_reason: input.persist ? "no_native_t2_write_path" : null,
    memory_candidate: null,
    ...extras,
  };
}

type PlannerStage = { ok: true; subquestions: string[] } | { ok: false; error: string };

async function runPlannerStage(
  ctx: FanoutCtx,
  input: Input,
  projectId: string,
  priorBrief: string | null,
): Promise<PlannerStage> {
  const fanout = await runFanout(ctx, {
    tasks: [
      {
        message: buildPlannerPrompt(input.question, input.angles, priorBrief),
        label: "planner",
        initial_agent: input.planner_agent,
        task_type: "plan_refine",
        tool_free: true,
      },
    ],
    defaults: fanoutDefaults(projectId, input.timeout_ms),
  });
  const result = fanout.results[0];
  if (!result?.ok) return { ok: false, error: "planner_dispatch_failed" };
  const parsed = parseStructured<PlannerResult>(result.response_text, PlannerSchema);
  if (!parsed.ok) return { ok: false, error: "planner_parse_failed" };
  if (parsed.value.subquestions.length === 0) {
    return { ok: false, error: "planner_zero_angles" };
  }
  const subquestions = validatePlannerSubquestions(parsed.value.subquestions, input.angles);
  if (!subquestions) return { ok: false, error: "planner_invalid" };
  return { ok: true, subquestions };
}

type ResearchStage =
  | {
      ok: true;
      findings: FindingSummary[];
      acceptedSources: string[];
      acceptedFindings: FindingResult[];
      acceptedSourceSet: Set<string>;
      anglesValid: number;
    }
  | { ok: false; anglesValid: number; findings: FindingSummary[]; acceptedSources: string[] };

async function runResearchStage(
  ctx: FanoutCtx,
  input: Input,
  projectId: string,
  webAgent: string,
  subquestions: string[],
): Promise<ResearchStage> {
  const fanout = await runFanout(ctx, {
    tasks: subquestions.map((sq, i) => ({
      message: buildResearchPrompt(sq),
      label: `research-${String(i)}`,
      initial_agent: webAgent,
      task_type: "debug_diagnose" as const,
      tool_free: false,
    })),
    defaults: fanoutDefaults(projectId, input.timeout_ms),
  });
  const findings: FindingSummary[] = [];
  const acceptedFindings: FindingResult[] = [];
  const acceptedSources: string[] = [];
  const acceptedSourceSet = new Set<string>();
  let anglesValid = 0;
  for (const [i, subquestion] of subquestions.entries()) {
    const result = fanout.results[i];
    const accepted = acceptFinding(result, subquestion);
    if (accepted) {
      anglesValid += 1;
      acceptedFindings.push(accepted);
      findings.push({
        subquestion: accepted.subquestion,
        sources: accepted.sources,
        findings_excerpt: findingsExcerpt(accepted.findings),
      });
      for (const url of accepted.sources) {
        if (!acceptedSourceSet.has(url)) {
          acceptedSourceSet.add(url);
          acceptedSources.push(url);
        }
      }
    }
  }
  if (anglesValid < subquestions.length) {
    return { ok: false, anglesValid, findings, acceptedSources };
  }
  return { ok: true, findings, acceptedSources, acceptedFindings, acceptedSourceSet, anglesValid };
}

function acceptFinding(
  result: { ok: boolean; response_text: string | null } | undefined,
  dispatched: string,
): FindingResult | null {
  if (!result?.ok) return null;
  const parsed = parseStructured<FindingResult>(result.response_text, FindingSchema);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (value.findings.trim().length === 0) return null;
  if (!isSubquestionMatch(value.subquestion, dispatched)) return null;
  const sources = validateSourceUrls(value.sources, RESEARCH_SOURCE_BOUNDS);
  if (!sources.ok) return null;
  return { subquestion: dispatched, findings: value.findings, sources: sources.urls };
}

type SynthesisStage =
  | { ok: true; report: string; summary: string; sources: string[] }
  | { ok: false; error: string };

async function runSynthesisStage(
  ctx: FanoutCtx,
  input: Input,
  projectId: string,
  priorBrief: string | null,
  acceptedFindings: FindingResult[],
  acceptedSourceSet: Set<string>,
): Promise<SynthesisStage> {
  const fanout = await runFanout(ctx, {
    tasks: [
      {
        message: buildSynthesisPrompt(input.question, priorBrief, acceptedFindings),
        label: "synthesis",
        initial_agent: input.synthesis_agent,
        task_type: "plan_refine",
        tool_free: true,
      },
    ],
    defaults: fanoutDefaults(projectId, input.timeout_ms),
  });
  const result = fanout.results[0];
  if (!result?.ok) return { ok: false, error: "synthesis_dispatch_failed" };
  const parsed = parseStructured<SynthesisResult>(result.response_text, SynthesisSchema);
  if (!parsed.ok) return { ok: false, error: "synthesis_invalid" };
  const value = parsed.value;
  if (value.report.trim().length === 0 || value.summary.trim().length === 0) {
    return { ok: false, error: "synthesis_invalid" };
  }
  const validatedSources = validateSourceUrls(value.sources, SYNTHESIS_SOURCE_BOUNDS);
  if (!validatedSources.ok) return { ok: false, error: "synthesis_invalid" };
  const invented = validatedSources.urls.some((url) => !acceptedSourceSet.has(url));
  if (invented) return { ok: false, error: "synthesis_invented_source" };
  return {
    ok: true,
    report: value.report,
    summary: boundSummary(value.summary),
    sources: validatedSources.urls,
  };
}

type ArtifactStage = { ok: true; path: string } | { ok: false };

async function writeArtifact(
  ctx: WorkflowCtx,
  input: Input,
  report: string,
): Promise<ArtifactStage> {
  const outDir = resolveOutDir(ctx, input.out_dir);
  if (!outDir.ok) return { ok: false };
  const stem = sanitizeFileStem(input.question.slice(0, 60));
  const artifactPath = join(outDir.path, `${stem}-${REPORT_FILENAME}`);
  let receipt: string;
  try {
    receipt = await ctx.fileWrite(artifactPath, report);
  } catch {
    return { ok: false };
  }
  if (typeof receipt !== "string" || receipt.trim().length === 0 || receipt !== artifactPath) {
    return { ok: false };
  }
  return { ok: true, path: receipt };
}

export const fn: WorkflowFn = async (
  ctx: WorkflowCtx,
  _recall: RecallBundle,
): Promise<ResearchResult> => {
  const input = inputSchema.parse(ctx.args);
  const projectId = input.project_id ?? ctx.project;
  const prime = primeFromMemory(ctx, input.question, projectId);
  const priorBrief = prime.brief.length > 0 ? prime.brief : null;

  const seat = resolveWebSeat(ctx.config, input.web_agent);
  if (!seat.ok) return failedResult(input, prime, "no_web_capable_seat");

  const fctx = ctx;

  const planner = await runPlannerStage(fctx, input, projectId, priorBrief);
  if (!planner.ok) return failedResult(input, prime, planner.error);
  const subquestions = planner.subquestions;
  if (subquestions.length === 0) return failedResult(input, prime, "planner_zero_angles");

  const research = await runResearchStage(fctx, input, projectId, seat.agent, subquestions);
  if (!research.ok) {
    return failedResult(input, prime, "angles_incomplete", {
      subquestions,
      angles_valid: research.anglesValid,
      findings: research.findings,
      sources: research.acceptedSources,
    });
  }

  const synthesis = await runSynthesisStage(
    fctx,
    input,
    projectId,
    priorBrief,
    research.acceptedFindings,
    research.acceptedSourceSet,
  );
  if (!synthesis.ok) {
    return failedResult(input, prime, synthesis.error, {
      subquestions,
      angles_valid: research.anglesValid,
      findings: research.findings,
      sources: research.acceptedSources,
    });
  }

  const artifact = await writeArtifact(ctx, input, synthesis.report);
  if (!artifact.ok) {
    return failedResult(input, prime, "artifact_write_failed", {
      subquestions,
      angles_valid: research.anglesValid,
      findings: research.findings,
      sources: research.acceptedSources,
      summary: synthesis.summary,
    });
  }

  return successResult(input, prime, subquestions, research, synthesis, artifact.path);
};

function successResult(
  input: Input,
  prime: MemoryPrime,
  subquestions: string[],
  research: { findings: FindingSummary[]; acceptedSources: string[]; anglesValid: number },
  synthesis: { summary: string; sources: string[] },
  reportPath: string,
): ResearchResult {
  const memoryCandidate: MemoryCandidate | null = input.persist
    ? {
        question: input.question,
        summary: synthesis.summary,
        source_urls: synthesis.sources,
        report_path: reportPath,
      }
    : null;
  return {
    ok: true,
    question: input.question,
    prior_brief: prime.brief.length > 0 ? prime.brief : null,
    subquestions,
    angles_requested: input.angles,
    angles_valid: research.anglesValid,
    findings: research.findings,
    sources: research.acceptedSources,
    summary: synthesis.summary,
    report_path: reportPath,
    persisted: false,
    persistence_reason: input.persist ? "no_native_t2_write_path" : null,
    memory_candidate: memoryCandidate,
  };
}

const spec: WorkflowSpec = {
  name: "penumbra-research",
  description:
    "Memory-augmented web research: prime with penumbra t2 memory, fan out sourced web research across sub-questions via the shared runFanout, synthesize a cited report, and write it to out_dir. No native t2 write — persisted is always false; a bounded memory_candidate is returned when persist is true.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "penumbra-research" }],
  recall: [],
  output: [],
  run: { kind: "ts-function" },
};

export default spec;
