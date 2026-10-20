import type { RecallBundle, WorkflowCtx, WorkflowFn, WorkflowSpec } from "@penumbra/workflows";

import {
  type FanoutOptions,
  type FanoutTask,
  type FanoutTaskResult,
  runFanout,
} from "../_shared/fanout.js";

const PROBE_CONTENT = "native worktree fan-out reached this worker";
const PROBE_DIR = "test/fixtures/native-fanout-smoke";
const DEFAULT_TIMEOUT_MS = 600_000;

type ProbeResult = {
  ok: boolean;
  worktree_proven: boolean;
  index: number;
  label: string;
  conversation_id: string | null;
  handoff_id: string | null;
  branch_name: string | null;
  status: "completed" | "failed" | "timeout" | "error";
  reliability_trustworthy: boolean | null;
  response_text: string | null;
  error_summary: string | null;
};

export type FanoutSmokeResult = {
  ok: boolean;
  count: number;
  completed: number;
  worktree_proven: number;
  results: ProbeResult[];
};

const spec: WorkflowSpec = {
  name: "fanout-smoke",
  description:
    "Native worktree fan-out smoke test: dispatch file-only probes across isolated worktrees and verify each via DB branch and dispatch reliability evidence.",
  triggers: [{ kind: "manual" }, { kind: "slash", command: "fanout-smoke" }],
  recall: [],
  output: [],
  run: { kind: "ts-function" },
};

export default spec;

function probePath(index: number): string {
  return `${PROBE_DIR}/probe-${String(index)}.txt`;
}

function probeMessage(index: number): string {
  const path = probePath(index);
  return [
    "This is a native worktree fan-out smoke probe.",
    `In your assigned worker worktree, create or modify only ${path} with exactly this single line:`,
    "",
    PROBE_CONTENT,
    "",
    "Stay in the assigned worker worktree and on its assigned branch. Do not cd, switch to main, switch branches, or use broad staging.",
    `If you own the commit operation, commit only ${path}.`,
    "If the dispatch reconciler owns the post-return commit, report honestly that the commit is pending.",
    "The coordinator must observe authoritative reconciler commit evidence before live acceptance; response prose alone is not commit proof.",
    "Do not ask the coordinator to run shell commands from your response.",
    "Return a short confirmation; do not claim the file was written or committed unless that operation completed in your assigned worker worktree.",
  ].join("\n");
}

function clampCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) return 2;
  return Math.min(Math.max(raw, 1), 4);
}

function waitTimeoutMs(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  return DEFAULT_TIMEOUT_MS;
}

function isWorktreeProven(result: { branch_name: string | null }): boolean {
  return typeof result.branch_name === "string" && result.branch_name.length > 0;
}

function summarizeResult(result: FanoutTaskResult): ProbeResult {
  return {
    ok: result.ok,
    worktree_proven: isWorktreeProven(result),
    index: result.index,
    label: result.label,
    conversation_id: result.conversation_id,
    handoff_id: result.handoff_id,
    branch_name: result.branch_name,
    status: result.status,
    reliability_trustworthy: result.reliability_trustworthy,
    response_text: result.response_text,
    error_summary: result.error_summary,
  };
}

export const fn: WorkflowFn = async (
  ctx: WorkflowCtx,
  _recall: RecallBundle,
): Promise<FanoutSmokeResult> => {
  const count = clampCount(ctx.args.count);
  const timeoutMs = waitTimeoutMs(ctx.args.timeout_ms);

  ctx.progress?.("fanout-smoke: building probes", { count, timeout_ms: timeoutMs });

  const tasks: FanoutTask[] = [];
  for (let i = 0; i < count; i++) {
    tasks.push({
      message: probeMessage(i),
      label: `fanout-smoke-${String(i)}`,
      task_name: `fanout-smoke-${String(i)}`,
    });
  }

  const options: FanoutOptions = {
    defaults: {
      initial_agent: "executor",
      task_class: "TRIVIAL",
      task_type: "docs_mechanical",
      use_worktree: true,
      isolated_install: false,
      max_hops: 2,
      branch_type: "smoke",
      project_id: ctx.project,
      timeout_ms: timeoutMs,
    },
    tasks,
  };

  ctx.progress?.("fanout-smoke: dispatching", { count });

  const fanout = await runFanout(ctx, options);

  const results = fanout.results.map(summarizeResult);
  const worktreeProvenCount = results.filter((r) => r.worktree_proven).length;
  const ok = fanout.ok && worktreeProvenCount === count;

  ctx.progress?.("fanout-smoke: completed", {
    ok,
    count,
    worktree_proven: worktreeProvenCount,
  });

  return {
    ok,
    count,
    completed: results.filter((r) => r.status === "completed").length,
    worktree_proven: worktreeProvenCount,
    results,
  };
};
