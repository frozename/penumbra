import type { WorkflowCtx } from "./ctx.js";
import type { RecallBundle } from "./recall.js";
import type { WorkflowSpec } from "./schema.js";

import { type GateName, GATES } from "./gates/index.js";
import {
  emitClipboardOutput,
  emitFileOutput,
  emitNextSessionPromptOutput,
  emitObservationOutput,
  emitSessionReminder,
  taskOutput,
} from "./outputs/index.js";
import { resolveTemplateVars, type TemplateVarContext } from "./template-vars.js";
import { renderTemplate } from "./template.js";

export type ExecuteOutcome = "success" | "render_error" | "run_error" | "gated_failure";

export type ExecuteResult = {
  outcome: ExecuteOutcome;
  composedPrompt?: string;
  runResult?: unknown;
  artifacts: string[];
  warnings: string[];
  errorMessage?: string;
  latencyMs: number;
  gateEvidence?: Partial<Record<GateName, string>>;
  sessionReminder?: string;
};

export type ExecuteOpts = {
  spec: WorkflowSpec;
  bundle: RecallBundle;
  fn?: WorkflowFn;
  ctx?: WorkflowCtx;
  storageRoot: string;
  captureCtx?: {
    db: import("bun:sqlite").Database;
    project: string;
    sessionId: string;
    userId: string;
    machineId: string;
    now?: () => Date;
  };
  captureKind?: "refresh" | "intentional";
  observationCtx?: {
    sessionId?: string | null;
    projectId?: string | null;
  };
  templateCtx?: TemplateVarContext;
  repoRoot?: string;
};

export type WorkflowFn<TArgs = Record<string, unknown>> = (
  ctx: WorkflowCtx<TArgs>,
  recall: RecallBundle,
) => Promise<unknown>;

type DisposableWorkflowCtx = WorkflowCtx & {
  dispose?: () => void;
};

function disposeWorkflowCtx(ctx: WorkflowCtx): void {
  const dispose = (ctx as DisposableWorkflowCtx).dispose;
  if (typeof dispose === "function") dispose.call(ctx);
}

function nestDottedKeys(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(flat)) {
    const parts = key.split(".");
    if (parts.length === 0) continue;
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i] ?? "";
      const next = cur[p];
      if (next && typeof next === "object" && !Array.isArray(next)) {
        cur = next as Record<string, unknown>;
      } else {
        const fresh: Record<string, unknown> = {};
        cur[p] = fresh;
        cur = fresh;
      }
    }
    cur[parts[parts.length - 1] ?? ""] = val;
  }
  return out;
}

// Gates whose required GateInput fields are populated by executeWorkflow.
// Anything outside this set is structurally unsatisfiable here: the gate
// verifier would either silently pass (false assurance) or trip its
// internal "inert" branch. Fail-closed: reject the spec instead.
const EXECUTOR_SATISFIABLE_GATES: ReadonlySet<GateName> = new Set<GateName>([
  "verification-before-complete",
]);

// Output sink kinds whose emit path is actually implemented by the executor.
// 'commit' and 'dispatch' are schema-valid but have no runtime implementation
// (they return {} — see emitOneSink), which would silently succeed with no
// artifact and no warning. Fail-closed: reject the spec instead of pretending.
type OutputSinkKind = WorkflowSpec["output"][number]["kind"];
const EXECUTOR_SATISFIABLE_OUTPUT_KINDS: ReadonlySet<OutputSinkKind> = new Set<OutputSinkKind>([
  "file",
  "clipboard",
  "next-session-prompt",
  "session-reminder",
  "observation",
  "task",
]);

function bodyFromRunResult(composedPrompt: string | undefined, runResult: unknown): string {
  if (composedPrompt !== undefined) return composedPrompt;
  if (typeof runResult === "string") return runResult;
  return JSON.stringify(runResult ?? {});
}

async function composePromptOrRun(
  spec: WorkflowSpec,
  bundle: RecallBundle,
  fn: WorkflowFn | undefined,
  baseCtx: WorkflowCtx,
  artifacts: string[],
  warnings: string[],
  tplCtx: TemplateVarContext,
): Promise<{ composedPrompt?: string; runResult?: unknown }> {
  if (spec.run.kind === "markdown-template") {
    const preExpanded = resolveTemplateVars(spec.run.template, tplCtx);
    const composedPrompt = renderTemplate(
      preExpanded,
      { recall: nestDottedKeys(bundle.byKey) },
      { warnings },
    );
    return { composedPrompt };
  }
  if (!fn) throw new Error("ts-function workflow has no fn bound");
  const context: WorkflowCtx = {
    ...baseCtx,
    fileWrite: async (relativePath: string, body: string): Promise<string> => {
      if (typeof baseCtx.fileWrite !== "function") {
        throw new Error("workflow ctx.fileWrite is not available");
      }
      const path = await baseCtx.fileWrite(relativePath, body);
      artifacts.push(path);
      return path;
    },
  };
  const runResult = await fn(context, bundle);
  return { runResult };
}

function runProcessGates(
  spec: WorkflowSpec,
  body: string,
): { gateEvidence: Partial<Record<GateName, string>>; blockingFailure: boolean } {
  const gateEvidence: Partial<Record<GateName, string>> = {};
  let blockingFailure = false;
  if (!spec.process_gates || spec.process_gates.length === 0) {
    return { gateEvidence, blockingFailure };
  }
  const gateInput = { text: body };
  for (const name of spec.process_gates) {
    const verify = GATES[name];
    const r = verify(gateInput);
    if (!r.passed) {
      gateEvidence[name] = r.evidence;
      if (r.severity === "blocking-in-session") blockingFailure = true;
    }
  }
  return { gateEvidence, blockingFailure };
}

type OutputCtx = {
  body: string;
  storageRoot: string;
  spec: WorkflowSpec;
  tplCtx: TemplateVarContext;
  opts: ExecuteOpts;
  start: number;
};

type SinkOutcome = { requiredFailure?: { kind: string; reason: string } };

async function handleObservationSink(
  sink: Extract<WorkflowSpec["output"][number], { kind: "observation" }>,
  octx: OutputCtx,
  artifacts: string[],
  warnings: string[],
): Promise<SinkOutcome> {
  const { body, storageRoot, spec, opts, start } = octx;
  const r = await emitObservationOutput({
    body,
    storageRoot,
    workflowName: spec.name,
    project: opts.observationCtx?.projectId ?? opts.captureCtx?.project ?? null,
    sessionId: opts.observationCtx?.sessionId ?? null,
    ts: new Date(start).toISOString(),
  });
  warnings.push(...r.warnings);
  if (r.eventId) {
    artifacts.push(`observation:${r.eventId}`);
    return {};
  }
  if (sink.optional) return {};
  return {
    requiredFailure: {
      kind: "observation",
      reason: r.warnings[r.warnings.length - 1] ?? "observation sink failed",
    },
  };
}

async function handleTaskSink(
  sink: Extract<WorkflowSpec["output"][number], { kind: "task" }>,
  octx: OutputCtx,
  artifacts: string[],
  warnings: string[],
): Promise<SinkOutcome> {
  const { storageRoot, spec, tplCtx } = octx;
  const r = await taskOutput(sink, {
    storageRoot,
    workflow: {
      name: spec.name,
      origin: (spec as WorkflowSpec & { origin?: string | null }).origin ?? undefined,
    },
    now: tplCtx.now,
    project: tplCtx.project,
    sessionStart: tplCtx.sessionStart,
    tz: tplCtx.tz,
    filePath: tplCtx.filePath,
  });
  warnings.push(...r.warnings);
  if (r.taskId) {
    artifacts.push(`task:${r.taskId}`);
    return {};
  }
  if (sink.optional) return {};
  return {
    requiredFailure: {
      kind: "task",
      reason: r.warnings[r.warnings.length - 1] ?? "task sink failed",
    },
  };
}

async function handleFileSink(
  sink: Extract<WorkflowSpec["output"][number], { kind: "file" }>,
  octx: OutputCtx,
  artifacts: string[],
  warnings: string[],
): Promise<SinkOutcome> {
  const { body, tplCtx, opts } = octx;
  const r = await emitFileOutput({
    path: resolveTemplateVars(sink.path, tplCtx),
    body,
    mode: sink.mode,
    repoRoot: opts.repoRoot,
  });
  warnings.push(...r.warnings);
  if (r.path) {
    artifacts.push(r.path);
    return {};
  }
  if (sink.optional) return {};
  return {
    requiredFailure: {
      kind: "file",
      reason: r.warnings[r.warnings.length - 1] ?? "file sink failed",
    },
  };
}

async function handleNextSessionPromptSink(
  sink: Extract<WorkflowSpec["output"][number], { kind: "next-session-prompt" }>,
  octx: OutputCtx,
  artifacts: string[],
  warnings: string[],
): Promise<SinkOutcome> {
  const { body, storageRoot } = octx;
  const r = await emitNextSessionPromptOutput({
    body,
    storageRoot,
    workflowName: octx.spec.name,
  });
  warnings.push(...r.warnings);
  if (r.path) {
    artifacts.push(r.path);
    return {};
  }
  if (r.skipped) return {};
  if (sink.optional) return {};
  return {
    requiredFailure: {
      kind: "next-session-prompt",
      reason: r.warnings[r.warnings.length - 1] ?? "next-session-prompt failed",
    },
  };
}

async function emitOneSink(
  sink: WorkflowSpec["output"][number],
  octx: OutputCtx,
  artifacts: string[],
  warnings: string[],
  sessionReminderTexts: string[],
): Promise<SinkOutcome> {
  const { body } = octx;
  switch (sink.kind) {
    case "file":
      return await handleFileSink(sink, octx, artifacts, warnings);
    case "clipboard": {
      const r = await emitClipboardOutput({ body });
      warnings.push(...r.warnings);
      return {};
    }
    case "next-session-prompt":
      return await handleNextSessionPromptSink(sink, octx, artifacts, warnings);
    case "session-reminder": {
      const r = emitSessionReminder({ text: body });
      if (r.text) sessionReminderTexts.push(r.text);
      return {};
    }
    case "observation":
      return await handleObservationSink(sink, octx, artifacts, warnings);
    case "task":
      return await handleTaskSink(sink, octx, artifacts, warnings);
    case "commit":
    case "dispatch":
      return {};
  }
}

async function finalizeAndCapture(
  opts: ExecuteOpts,
  start: number,
  artifacts: string[],
  warnings: string[],
  recallSourceNames: string[],
  itemCount: number,
  outcome: ExecuteOutcome,
  rest?: Partial<Omit<ExecuteResult, "outcome" | "artifacts" | "warnings" | "latencyMs">>,
): Promise<ExecuteResult> {
  const result: ExecuteResult = { outcome, artifacts, warnings, latencyMs: Date.now() - start, ...rest };
  await runCapture(opts, result, recallSourceNames, itemCount);
  return result;
}

function preRunFailureReason(spec: WorkflowSpec, bundle: RecallBundle): string | undefined {
  const badGates = (spec.process_gates ?? []).filter((g) => !EXECUTOR_SATISFIABLE_GATES.has(g));
  if (badGates.length > 0) {
    return `spec lists process_gates the executor cannot satisfy: ${badGates.join(", ")}`;
  }
  const badOutputs = spec.output.map((o) => o.kind).filter((k) => !EXECUTOR_SATISFIABLE_OUTPUT_KINDS.has(k));
  if (badOutputs.length > 0) {
    return `spec lists output kinds the executor cannot satisfy: ${badOutputs.join(", ")}`;
  }
  const requiredRecallFailures = bundle.requiredFailures ?? [];
  if (requiredRecallFailures.length > 0) {
    return `required recall source(s) failed — ${requiredRecallFailures
      .map((f) => `${f.source}: ${f.message}`)
      .join("; ")}`;
  }
  return undefined;
}

export async function executeWorkflow(opts: ExecuteOpts): Promise<ExecuteResult> {
  const start = Date.now();
  const { spec, bundle, fn, storageRoot } = opts;
  const warnings: string[] = [...bundle.warnings];
  const artifacts: string[] = [];

  const recallSourceNames = spec.recall.map((r) => r.source);
  const itemCount = Object.values(bundle.byKey).reduce<number>(
    (sum, v) => sum + (Array.isArray(v) ? v.length : v ? 1 : 0),
    0,
  );

  const preRunFailure = preRunFailureReason(spec, bundle);
  if (preRunFailure) {
    return await finalizeAndCapture(
      opts,
      start,
      artifacts,
      warnings,
      recallSourceNames,
      itemCount,
      "run_error",
      { errorMessage: preRunFailure },
    );
  }

  const tplCtx: TemplateVarContext = opts.templateCtx ?? {
    now: (): Date => new Date(),
    project: opts.captureCtx?.project ?? "unknown",
    sessionStart: new Date(start).toISOString(),
    tz: process.env.TZ ?? "UTC",
    cwd: process.cwd(),
    repoRoot: opts.repoRoot ?? process.cwd(),
  };

  let composedPrompt: string | undefined;
  let runResult: unknown;

  try {
    const baseCtx = opts.ctx ?? ({} as WorkflowCtx);
    try {
      const ran = await composePromptOrRun(spec, bundle, fn, baseCtx, artifacts, warnings, tplCtx);
      composedPrompt = ran.composedPrompt;
      runResult = ran.runResult;
    } finally {
      disposeWorkflowCtx(baseCtx);
    }
  } catch (err: unknown) {
    return await finalizeAndCapture(
      opts,
      start,
      artifacts,
      warnings,
      recallSourceNames,
      itemCount,
      spec.run.kind === "markdown-template" ? "render_error" : "run_error",
      { composedPrompt, errorMessage: err instanceof Error ? err.message : String(err) },
    );
  }

  const body = bodyFromRunResult(composedPrompt, runResult);
  const { gateEvidence, blockingFailure } = runProcessGates(spec, body);
  if (blockingFailure) {
    return await finalizeAndCapture(
      opts,
      start,
      artifacts,
      warnings,
      recallSourceNames,
      itemCount,
      "gated_failure",
      { composedPrompt, runResult, gateEvidence },
    );
  }

  const octx: OutputCtx = { body, storageRoot, spec, tplCtx, opts, start };
  const sinkRun = await runOutputSinks(spec, octx, artifacts, warnings);
  const sessionReminder = sinkRun.sessionReminderTexts.length
    ? sinkRun.sessionReminderTexts.join("\n\n")
    : undefined;
  const gateEvidenceOut = Object.keys(gateEvidence).length ? gateEvidence : undefined;

  return await finalizeAndCapture(
    opts,
    start,
    artifacts,
    warnings,
    recallSourceNames,
    itemCount,
    sinkRun.requiredFailures.length > 0 ? "run_error" : "success",
    {
      composedPrompt,
      runResult,
      gateEvidence: gateEvidenceOut,
      sessionReminder,
      ...(sinkRun.requiredFailures.length > 0
        ? {
            errorMessage: `required output sink(s) failed — ${sinkRun.requiredFailures
              .map((f) => `${f.kind}: ${f.reason}`)
              .join("; ")}`,
          }
        : {}),
    },
  );
}

async function runOutputSinks(
  spec: WorkflowSpec,
  octx: OutputCtx,
  artifacts: string[],
  warnings: string[],
): Promise<{
  sessionReminderTexts: string[];
  requiredFailures: { kind: string; reason: string }[];
}> {
  const sessionReminderTexts: string[] = [];
  const requiredFailures: { kind: string; reason: string }[] = [];
  for (const sink of spec.output) {
    const sinkResult = await emitOneSink(sink, octx, artifacts, warnings, sessionReminderTexts);
    if (sinkResult.requiredFailure) requiredFailures.push(sinkResult.requiredFailure);
  }
  return { sessionReminderTexts, requiredFailures };
}

async function runCapture(
  opts: ExecuteOpts,
  result: ExecuteResult,
  recallSourceNames: string[],
  itemCount: number,
): Promise<void> {
  if (!opts.captureCtx) return;
  const { captureWorkflowOutcome } = await import("./capture.js");
  captureWorkflowOutcome({
    db: opts.captureCtx.db,
    workflowName: opts.spec.name,
    outcome: result.outcome,
    latencyMs: result.latencyMs,
    artifacts: result.artifacts,
    warnings: result.warnings,
    recallSummary: { sources: recallSourceNames, itemCount },
    errorMessage: result.errorMessage,
    gateEvidence: result.gateEvidence as Record<string, string> | undefined,
    project: opts.captureCtx.project,
    sessionId: opts.captureCtx.sessionId,
    userId: opts.captureCtx.userId,
    machineId: opts.captureCtx.machineId,
    now: opts.captureCtx.now ?? ((): Date => new Date()),
    kind: opts.captureKind ?? "intentional",
  });
}
