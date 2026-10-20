import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { z } from "zod";

import {
  type FanoutDefaults,
  type FanoutResult,
  type FanoutTask,
  type FanoutTaskResult,
  runFanout,
} from "../_shared/fanout.js";
import { resolveOutDir } from "../_shared/io.js";
import { type BoundedResult, buildBoundedResult } from "./dispatch.js";
import { buildPlannerPrompt, parsePlan, toFanoutTasks, validatePlanTasks } from "./planner.js";

const TaskClassEnum = z.enum(["BOUNDARY", "STANDARD", "TRIVIAL"]);
const TaskTypeEnum = z.enum([
  "plan_refine",
  "implement_small",
  "implement_substantial",
  "review_adversarial",
  "docs_mechanical",
  "debug_diagnose",
  "smoke_test",
  "health_check",
  "unknown",
]);
const TrustModeEnum = z.enum(["all", "config"]);

const CALLER_CWD_PARENT_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/;

function containsControlCharacter(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) return true;
  }
  return false;
}

function isValidCallerCwd(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!value.startsWith("/")) return false;
  if (containsControlCharacter(value)) return false;
  if (CALLER_CWD_PARENT_SEGMENT.test(value)) return false;
  return true;
}

const sharedDefaultsFields = {
  initial_agent: z.string().min(1).optional(),
  task_name: z.string().min(1).max(120).optional(),
  branch_type: z.string().min(1).optional(),
  task_class: TaskClassEnum.optional(),
  task_type: TaskTypeEnum.optional(),
  trust_mode: TrustModeEnum.optional(),
  use_worktree: z.boolean().optional(),
  max_hops: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  project_id: z.string().min(1).optional(),
  parent_handoff_id: z.string().min(1).optional(),
  branch_base: z.string().min(1).optional(),
  isolated_install: z.boolean().optional(),
  tool_free: z.boolean().optional(),
};

const DefaultsSchema = z.object({ ...sharedDefaultsFields }).strict();

export const inputSchema = z
  .object({
    goal: z.string().min(1),
    max_tasks: z.number().int().min(0).max(16).default(8),
    planner_agent: z.string().min(1).default("executor"),
    timeout_ms: z.number().int().positive().default(1_800_000),
    defaults: DefaultsSchema.optional(),
    project_id: z.string().min(1).optional(),
    caller_cwd: z.string().optional().refine(isValidCallerCwd, {
      message:
        "caller_cwd must be an absolute path with no control characters or parent-directory segments",
    }),
    use_worktree: z.boolean().optional(),
    isolated_install: z.boolean().optional(),
    branch_base: z.string().min(1).optional(),
    out_dir: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type PlannerSummary = {
  handoff_id: string | null;
  conversation_id: string | null;
  root_handoff_id: string | null;
  latest_handoff_id: string | null;
  branch_name: string | null;
  reliability_trustworthy: boolean | null;
  reliability_status: string | null;
  hop_count: number | null;
  extra_hops: number | null;
};

export type PlanSummary = {
  summary: string | null;
  task_count: number;
  dropped_count: number;
};

export type FanoutSummary = {
  ok: boolean;
  total: number;
  completed: number;
  failed: number;
  branches: string[];
  results: BoundedResult[];
};

export type SwarmResult = {
  ok: boolean;
  goal: string;
  error: string | null;
  planner: PlannerSummary | null;
  plan: PlanSummary | null;
  fanout: FanoutSummary | null;
  branches: string[];
};

function buildMergedDefaults(input: Input): FanoutDefaults {
  const result: FanoutDefaults = {
    timeout_ms: input.timeout_ms,
    ...input.defaults,
  };
  if (input.project_id !== undefined) result.project_id = input.project_id;
  if (input.use_worktree !== undefined) result.use_worktree = input.use_worktree;
  if (input.isolated_install !== undefined) result.isolated_install = input.isolated_install;
  if (input.branch_base !== undefined) result.branch_base = input.branch_base;
  return result;
}

function buildPlannerTask(input: Input): FanoutTask {
  return {
    message: buildPlannerPrompt(input.goal, input.max_tasks),
    label: "plan",
    initial_agent: input.planner_agent,
    tool_free: true,
    use_worktree: false,
    max_hops: 1,
    task_type: "plan_refine",
  };
}

function summarizePlanner(result: FanoutTaskResult | undefined): PlannerSummary {
  if (!result) {
    return {
      handoff_id: null,
      conversation_id: null,
      root_handoff_id: null,
      latest_handoff_id: null,
      branch_name: null,
      reliability_trustworthy: null,
      reliability_status: null,
      hop_count: null,
      extra_hops: null,
    };
  }
  return {
    handoff_id: result.handoff_id,
    conversation_id: result.conversation_id,
    root_handoff_id: result.root_handoff_id,
    latest_handoff_id: result.latest_handoff_id,
    branch_name: result.branch_name,
    reliability_trustworthy: result.reliability_trustworthy,
    reliability_status: result.reliability_status,
    hop_count: result.hop_count,
    extra_hops: result.extra_hops,
  };
}

function failureResult(goal: string, planner: PlannerSummary | null, error: string): SwarmResult {
  return {
    ok: false,
    goal,
    error,
    planner,
    plan: null,
    fanout: null,
    branches: [],
  };
}

function resolveOutDirPath(ctx: WorkflowCtx, outDir: string | undefined): string {
  const resolved = resolveOutDir(ctx, outDir);
  if (!resolved.ok) {
    throw new Error("penumbra-swarm: out_dir resolves outside allowed roots");
  }
  return resolved.path;
}

function buildFanoutSummary(fanout: FanoutResult, boundedResults: BoundedResult[]): FanoutSummary {
  const completed = boundedResults.filter((r) => r.ok).length;
  const failed = boundedResults.length - completed;
  const branches = boundedResults
    .filter(
      (r): r is BoundedResult & { latest_branch_name: string } =>
        r.ok && typeof r.latest_branch_name === "string" && r.latest_branch_name.length > 0,
    )
    .map((r) => r.latest_branch_name);
  return {
    ok: fanout.ok && boundedResults.every((r) => r.ok),
    total: boundedResults.length,
    completed,
    failed,
    branches,
    results: boundedResults,
  };
}

export const fn: WorkflowFn = async (
  ctx: WorkflowCtx,
  _recall: RecallBundle,
): Promise<SwarmResult> => {
  const input = inputSchema.parse(ctx.args);

  if (input.max_tasks === 0) {
    return {
      ok: false,
      goal: input.goal,
      error: "empty_plan",
      planner: null,
      plan: null,
      fanout: null,
      branches: [],
    };
  }

  const mergedDefaults = buildMergedDefaults(input);

  ctx.progress?.("penumbra-swarm: planning", { goal: input.goal, max_tasks: input.max_tasks });
  const plannerFanout = await runFanout(ctx, {
    tasks: [buildPlannerTask(input)],
    defaults: mergedDefaults,
  });
  const plannerResult = plannerFanout.results[0] ?? undefined;
  const plannerSummary = summarizePlanner(plannerResult);

  if (!plannerResult || !plannerResult.ok || plannerResult.reliability_trustworthy !== true) {
    return failureResult(input.goal, plannerSummary, "planner_untrustworthy");
  }

  const parsed = parsePlan(plannerResult.response_text);
  if (!parsed.ok) {
    const detail = parsed.issues ? `${parsed.error}:${parsed.issues.join(";")}` : parsed.error;
    return failureResult(input.goal, plannerSummary, `plan_parse_failed:${detail}`);
  }

  const validation = validatePlanTasks(parsed.plan, input.max_tasks);
  if (!validation.ok) {
    return failureResult(input.goal, plannerSummary, validation.error);
  }

  ctx.progress?.("penumbra-swarm: planner complete", {
    task_count: validation.tasks.length,
    dropped: validation.dropped,
  });

  const implTasks = toFanoutTasks(validation.tasks, mergedDefaults);
  const outDirPath = resolveOutDirPath(ctx, input.out_dir);

  ctx.progress?.("penumbra-swarm: dispatching", { count: implTasks.length });
  const implFanout = await runFanout(ctx, { tasks: implTasks, defaults: mergedDefaults });

  const boundedResults = await Promise.all(
    implFanout.results.map((r) => buildBoundedResult(r, outDirPath, ctx)),
  );

  const fanoutSummary = buildFanoutSummary(implFanout, boundedResults);

  ctx.progress?.("penumbra-swarm: completed", {
    ok: fanoutSummary.ok,
    total: fanoutSummary.total,
    completed: fanoutSummary.completed,
    failed: fanoutSummary.failed,
  });

  return {
    ok: fanoutSummary.ok,
    goal: input.goal,
    error: null,
    planner: plannerSummary,
    plan: {
      summary: parsed.plan.summary ?? null,
      task_count: validation.tasks.length,
      dropped_count: validation.dropped,
    },
    fanout: fanoutSummary,
    branches: fanoutSummary.branches,
  };
};

const spec: WorkflowSpec = {
  name: "penumbra-swarm",
  description:
    "Decompose a high-level goal into N independent penumbra task specs with a planner agent, then fan them out to the fleet via chain_start and collect every result with bounded response artifacts.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "penumbra-swarm" }],
  recall: [],
  output: [],
  run: { kind: "ts-function" },
};

export default spec;
