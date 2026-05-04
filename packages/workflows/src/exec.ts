import type { WorkflowSpec } from './schema.js';
import { renderTemplate } from './template.js';
import type { RecallBundle } from './recall.js';
import { GATES, type GateName } from './gates/index.js';
import {
  emitFileOutput,
  emitClipboardOutput,
  emitNextSessionPromptOutput,
} from './outputs/index.js';

export type ExecuteOutcome = 'success' | 'render_error' | 'run_error' | 'gated_failure';

export type ExecuteResult = {
  outcome: ExecuteOutcome;
  composedPrompt?: string;
  runResult?: unknown;
  artifacts: string[];
  warnings: string[];
  errorMessage?: string;
  latencyMs: number;
  gateEvidence?: Partial<Record<GateName, string>>;
};

export type ExecuteOpts = {
  spec: WorkflowSpec;
  bundle: RecallBundle;
  fn?: (ctx: unknown, recall: unknown) => Promise<unknown>;
  storageRoot: string;
  captureCtx?: {
    db: import('bun:sqlite').Database;
    project: string;
    sessionId: string;
    userId: string;
    machineId: string;
    now?: () => Date;
  };
};

function nestDottedKeys(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(flat)) {
    const parts = key.split('.');
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      const next = cur[p];
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        cur = next as Record<string, unknown>;
      } else {
        const fresh: Record<string, unknown> = {};
        cur[p] = fresh;
        cur = fresh;
      }
    }
    cur[parts[parts.length - 1]!] = val;
  }
  return out;
}

export async function executeWorkflow(opts: ExecuteOpts): Promise<ExecuteResult> {
  const start = Date.now();
  const { spec, bundle, fn, storageRoot } = opts;
  const warnings: string[] = [...bundle.warnings];
  const artifacts: string[] = [];

  const recallSourceNames = spec.recall.map((r) => r.source);
  const itemCount = Object.values(bundle.byKey).reduce(
    (sum, v) => sum + (Array.isArray(v) ? v.length : v ? 1 : 0),
    0,
  );

  let composedPrompt: string | undefined;
  let runResult: unknown;

  try {
    if (spec.run.kind === 'markdown-template') {
      composedPrompt = renderTemplate(
        spec.run.template,
        { recall: nestDottedKeys(bundle.byKey) } as Record<string, unknown>,
        { warnings },
      );
    } else if (spec.run.kind === 'ts-function') {
      if (!fn) throw new Error('ts-function workflow has no fn bound');
      runResult = await fn({}, bundle);
    }
  } catch (err: any) {
    const result: ExecuteResult = {
      outcome: spec.run.kind === 'markdown-template' ? 'render_error' : 'run_error',
      composedPrompt,
      artifacts,
      warnings,
      errorMessage: err?.message ?? String(err),
      latencyMs: Date.now() - start,
    };
    await runCapture(opts, result, recallSourceNames, itemCount);
    return result;
  }

  const gateEvidence: Partial<Record<GateName, string>> = {};
  let blockingFailure = false;
  if (spec.process_gates && spec.process_gates.length > 0) {
    const gateInput = {
      text: composedPrompt ?? (typeof runResult === 'string' ? runResult : JSON.stringify(runResult ?? {})),
    };
    for (const name of spec.process_gates) {
      const verify = GATES[name];
      if (!verify) continue;
      const r = verify(gateInput);
      if (!r.passed) {
        gateEvidence[name] = r.evidence;
        if (r.severity === 'blocking-in-session') blockingFailure = true;
      }
    }
  }
  if (blockingFailure) {
    const result: ExecuteResult = {
      outcome: 'gated_failure',
      composedPrompt,
      runResult,
      artifacts,
      warnings,
      latencyMs: Date.now() - start,
      gateEvidence,
    };
    await runCapture(opts, result, recallSourceNames, itemCount);
    return result;
  }

  for (const sink of spec.output) {
    const body = composedPrompt ?? JSON.stringify(runResult ?? {});
    if (sink.kind === 'file') {
      const r = await emitFileOutput({ path: sink.path, body });
      warnings.push(...r.warnings);
      if (r.path) artifacts.push(r.path);
    } else if (sink.kind === 'clipboard') {
      const r = await emitClipboardOutput({ body });
      warnings.push(...r.warnings);
    } else if (sink.kind === 'next-session-prompt') {
      const r = await emitNextSessionPromptOutput({ body, storageRoot });
      warnings.push(...r.warnings);
      if (r.path) artifacts.push(r.path);
    }
  }

  const result: ExecuteResult = {
    outcome: 'success',
    composedPrompt,
    runResult,
    artifacts,
    warnings,
    latencyMs: Date.now() - start,
    gateEvidence: Object.keys(gateEvidence).length ? gateEvidence : undefined,
  };
  await runCapture(opts, result, recallSourceNames, itemCount);
  return result;
}

async function runCapture(
  opts: ExecuteOpts,
  result: ExecuteResult,
  recallSourceNames: string[],
  itemCount: number,
): Promise<void> {
  if (!opts.captureCtx) return;
  const { captureWorkflowOutcome } = await import('./capture.js');
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
    now: opts.captureCtx.now ?? (() => new Date()),
  });
}
