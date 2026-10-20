import { z } from "zod";

import type { FanoutDefaults, FanoutTask } from "../_shared/fanout.js";

import { parseStructured, renderJsonContract } from "../_shared/structured.js";

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

const planTaskFields = {
  message: z.string().min(1).max(10_000),
  label: z.string().min(1).max(120).optional(),
  task_name: z.string().min(1).max(120).optional(),
  branch_type: z.string().min(1).optional(),
  initial_agent: z.string().min(1).optional(),
  task_class: TaskClassEnum,
  task_type: TaskTypeEnum,
  trust_mode: TrustModeEnum.optional(),
  use_worktree: z.boolean().optional(),
  max_hops: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  project_id: z.string().min(1).optional(),
  parent_handoff_id: z.string().min(1).optional(),
  branch_base: z.string().min(1).optional(),
  isolated_install: z.boolean().optional(),
  tool_free: z.boolean().optional(),
  rationale: z.string().max(500).optional(),
};

export const PlanTaskSchema = z.object(planTaskFields).strict();

export const PlanSchema = z
  .object({
    summary: z.string().max(500).optional(),
    tasks: z.array(PlanTaskSchema).min(1).max(32),
  })
  .strict();

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

const PLAN_EXAMPLE = [
  "{",
  '  "summary": "one-line read of the decomposition",',
  '  "tasks": [',
  "    {",
  '      "task_class": "STANDARD",',
  '      "task_type": "implement_small",',
  '      "message": "self-contained instruction with file paths and acceptance check",',
  '      "label": "short-label"',
  "    }",
  "  ]",
  "}",
].join("\n");

export function buildPlannerPrompt(goal: string, maxTasks: number): string {
  const lines: string[] = [];
  lines.push(
    "You are a dispatch planner for the penumbra agent fleet. Decompose the GOAL below into a set of INDEPENDENT tasks that can run fully in parallel.",
    "",
    "Hard constraints:",
    `- At most ${String(maxTasks)} tasks. Fewer is better — only split where parallelism genuinely helps.`,
    "- Each task runs in its OWN isolated git worktree branched from the default branch. Tasks CANNOT see each other's changes or any uncommitted work. Do NOT create tasks that depend on a sibling task's output, or that edit the same files. If the work is inherently sequential or shares files, return a single task.",
    '- Each message must be fully self-contained: state the file paths, the exact change, and the acceptance check. No references to "the other task".',
    "- Classify each task_class: BOUNDARY (architectural / cross-cutting / risky), STANDARD (normal feature/fix), TRIVIAL (mechanical, low-risk).",
    '- Pick a task_type from the enum. Set initial_agent to the role "executor" (the default — the daemon model task router picks the seat). Pin a concrete agent id ONLY when the task needs a specific capability; put the pin reason in rationale.',
    "",
    "GOAL:",
    goal,
    "",
    "Return ONLY the StructuredOutput (summary + tasks). Do NOT dispatch anything yourself — planning only.",
    "",
    renderJsonContract({ example: PLAN_EXAMPLE, name: "penumbra-swarm plan" }),
  );
  return lines.join("\n");
}

export type PlanParseResult =
  | { ok: true; plan: Plan }
  | { ok: false; error: string; issues?: string[] };

export function parsePlan(responseText: string | null): PlanParseResult {
  const parsed = parseStructured(responseText, PlanSchema);
  if (!parsed.ok) return parsed;
  return { ok: true, plan: parsed.value };
}

export type PlanValidationResult =
  | { ok: true; tasks: PlanTask[]; dropped: number }
  | { ok: false; error: string };

function resolveTaskLabel(task: PlanTask, index: number): string {
  return task.label ?? `task-${String(index)}`;
}

function resolveTaskName(task: PlanTask, defaults?: FanoutDefaults): string | undefined {
  if (task.task_name !== undefined) return task.task_name;
  if (task.label === undefined) return defaults?.task_name;
  return undefined;
}

export function validatePlanTasks(plan: Plan, maxTasks: number): PlanValidationResult {
  const allTasks = plan.tasks;
  if (allTasks.length === 0) return { ok: false, error: "empty_plan" };

  const truncated = allTasks.slice(0, maxTasks);
  const seenLabels = new Set<string>();
  for (const [index, task] of truncated.entries()) {
    const label = resolveTaskLabel(task, index);
    if (seenLabels.has(label)) return { ok: false, error: "duplicate_task_label" };
    seenLabels.add(label);
  }

  const dropped = allTasks.length - truncated.length;
  return { ok: true, tasks: truncated, dropped };
}

export function toFanoutTasks(tasks: readonly PlanTask[], defaults?: FanoutDefaults): FanoutTask[] {
  return tasks.map((task, index) => {
    const { rationale: _r, ...rest } = task;
    return {
      ...rest,
      label: resolveTaskLabel(task, index),
      task_name: resolveTaskName(task, defaults),
    };
  });
}
