import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import { join } from "node:path";
import { z } from "zod";

import {
  type FanoutDefaults,
  type FanoutTask,
  type FanoutTaskResult,
  runFanout,
} from "../_shared/fanout.js";
import { resolveOutDir, sanitizeFileStem } from "../_shared/io.js";

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
const ResponseModeEnum = z.enum(["full", "first_line", "none"]);

const sharedFields = {
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
  response_mode: ResponseModeEnum.optional(),
};

const TaskSchema = z
  .object({
    message: z.string().min(1),
    label: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(120).optional(),
    ...sharedFields,
  })
  .strict();

const DefaultsSchema = z.object({ ...sharedFields }).strict();

export const inputSchema = z
  .object({
    tasks: z.array(TaskSchema).min(1).max(16),
    defaults: DefaultsSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    out_dir: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type ResponseMode = z.infer<typeof ResponseModeEnum>;

export type FanoutWorkflowTaskResult = Omit<FanoutTaskResult, "response_text"> & {
  response_mode: ResponseMode;
  response_path: string | null;
  response_chars: number | null;
  check_line: string | null;
  failure_tail: string | null;
};

export type FanoutWorkflowResult = {
  ok: boolean;
  total: number;
  completed: number;
  failed: number;
  branches: string[];
  results: FanoutWorkflowTaskResult[];
};

const CHECK_LINE_MAX = 300;
const FAILURE_TAIL_MAX = 4000;

function resolveLabel(task: Input["tasks"][number], index: number): string {
  return task.label ?? task.task_name ?? task.name ?? task.title ?? `task-${String(index)}`;
}

function resolveTaskName(
  task: Input["tasks"][number],
  defaults: Input["defaults"],
): string | undefined {
  return task.task_name ?? task.label ?? task.name ?? task.title ?? defaults?.task_name;
}

function resolveResponseMode(
  task: Input["tasks"][number],
  defaults: Input["defaults"],
): ResponseMode {
  return task.response_mode ?? defaults?.response_mode ?? "full";
}

function buildFanoutTask(
  task: Input["tasks"][number],
  defaults: Input["defaults"],
  index: number,
): FanoutTask {
  const label = resolveLabel(task, index);
  const taskName = resolveTaskName(task, defaults);
  const { name: _n, title: _t, response_mode: _rm, label: _l, ...rest } = task;
  const fanoutTask: FanoutTask = { ...rest, label };
  if (taskName !== undefined) fanoutTask.task_name = taskName;
  return fanoutTask;
}

function buildFanoutDefaults(
  defaults: Input["defaults"],
  topLevelTimeoutMs: number | undefined,
): FanoutDefaults {
  if (!defaults) return topLevelTimeoutMs !== undefined ? { timeout_ms: topLevelTimeoutMs } : {};
  const { response_mode: _rm, ...rest } = defaults;
  const result: FanoutDefaults = { ...rest };
  if (topLevelTimeoutMs !== undefined && result.timeout_ms === undefined) {
    result.timeout_ms = topLevelTimeoutMs;
  }
  return result;
}

function firstNonemptyLine(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, maxLen);
  }
  return null;
}

function failureTail(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  return text.length > maxLen ? text.slice(-maxLen) : text;
}

function isCheckFailure(line: string | null): boolean {
  return line !== null && /^CHECK_RESULT:\s*FAIL\b/i.test(line);
}

function isValidWriteReceipt(receipt: unknown, artifactPath: string): receipt is string {
  return typeof receipt === "string" && receipt.trim().length > 0 && receipt === artifactPath;
}

async function applyResponseMode(
  result: FanoutTaskResult,
  mode: ResponseMode,
  outDirPath: string | null,
  ctx: WorkflowCtx,
): Promise<FanoutWorkflowTaskResult> {
  const { response_text: responseText, ...summary } = result;
  const base: FanoutWorkflowTaskResult = {
    ...summary,
    response_mode: mode,
    response_path: null,
    response_chars: null,
    check_line: null,
    failure_tail: null,
  };

  if (mode === "none" || !responseText) return base;

  if (mode === "first_line") {
    base.check_line = firstNonemptyLine(responseText, CHECK_LINE_MAX);
    if (!result.ok || isCheckFailure(base.check_line)) {
      base.failure_tail = failureTail(responseText, FAILURE_TAIL_MAX);
    }
    return base;
  }

  if (!outDirPath) return base;
  const artifactPath = join(
    outDirPath,
    `${sanitizeFileStem(result.label)}-${String(result.index)}.txt`,
  );
  try {
    const written = await ctx.fileWrite(artifactPath, responseText);
    if (!isValidWriteReceipt(written, artifactPath)) {
      throw new Error("invalid response artifact write receipt");
    }
    base.response_path = written;
    base.response_chars = responseText.length;
    base.check_line = firstNonemptyLine(responseText, CHECK_LINE_MAX);
  } catch {
    base.ok = false;
    base.error_summary = base.error_summary
      ? `${base.error_summary}; response_artifact_write_failed`
      : "response_artifact_write_failed";
    base.response_path = null;
  }
  return base;
}

export const fn: WorkflowFn = async (
  ctx: WorkflowCtx,
  _recall: RecallBundle,
): Promise<FanoutWorkflowResult> => {
  const input = inputSchema.parse(ctx.args);
  const defaults = input.defaults;

  const responseModes = input.tasks.map((t) => resolveResponseMode(t, defaults));
  const needsOutDir = responseModes.some((m) => m === "full");

  let outDirPath: string | null = null;
  if (needsOutDir) {
    const outDir = resolveOutDir(ctx, input.out_dir);
    if (!outDir.ok) {
      throw new Error("penumbra-fanout: out_dir resolves outside allowed roots");
    }
    outDirPath = outDir.path;
  }

  const fanoutTasks = input.tasks.map((t, i) => buildFanoutTask(t, defaults, i));
  const fanoutDefaults = buildFanoutDefaults(defaults, input.timeout_ms);

  ctx.progress?.("penumbra-fanout: dispatching", { count: fanoutTasks.length });

  const fanout = await runFanout(ctx, { tasks: fanoutTasks, defaults: fanoutDefaults });

  const results = await Promise.all(
    fanout.results.map((r, i) => applyResponseMode(r, responseModes[i] ?? "full", outDirPath, ctx)),
  );

  const completed = results.filter((r) => r.ok).length;
  const failed = results.length - completed;
  const branches = results
    .filter(
      (r): r is FanoutWorkflowTaskResult & { branch_name: string } =>
        r.ok && typeof r.branch_name === "string" && r.branch_name.length > 0,
    )
    .map((r) => r.branch_name);
  const ok = fanout.ok && results.every((r) => r.ok);

  ctx.progress?.("penumbra-fanout: completed", { ok, total: results.length, completed, failed });

  return { ok, total: results.length, completed, failed, branches, results };
};

const spec: WorkflowSpec = {
  name: "penumbra-fanout",
  description:
    "Fan out N independent tasks to the penumbra fleet via chain_start (one dispatch per task), wait for each to terminate, and collect every worker result with bounded response artifacts and dispatch reliability evidence.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "penumbra-fanout" }],
  recall: [],
  output: [],
  run: { kind: "ts-function" },
};

export default spec;
