import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BoundsInput,
  type Eligibility,
  type FileTaskInput,
  type TaskPriority,
} from '@penumbra/core';
import { resolveTemplateVars, type TemplateVarContext } from '../template-vars.js';

export type TaskOutputConfig = {
  kind: 'task';
  prompt: string;
  acceptance_criteria?: string;
  expected_artifacts?: FileTaskInput['expected_artifacts'];
  eligibility?: Eligibility;
  kind?: FileTaskInput['kind'];
  bounds?: BoundsInput;
  review_eligibility?: Eligibility;
  priority?: TaskPriority;
  requires_review?: boolean;
};

export type TaskOutputCtx = TemplateVarContext & {
  workflow: { name: string; origin?: string | null };
  storageRoot: string;
};

export type TaskOutputResult = { warnings: string[]; taskId?: string };

function readDaemon(storageRoot: string): { baseUrl: string; token: string } | null {
  const portPath = join(storageRoot, 'port');
  const tokenPath = join(storageRoot, 'token');
  if (!existsSync(portPath) || !existsSync(tokenPath)) return null;
  const port = readFileSync(portPath, 'utf8').trim();
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!port || Number.isNaN(Number(port)) || !token) return null;
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

function resolveDeepStrings(value: unknown, ctx: TemplateVarContext): unknown {
  if (typeof value === 'string') return resolveTemplateVars(value, ctx);
  if (Array.isArray(value)) return value.map((item) => resolveDeepStrings(item, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = resolveDeepStrings(val, ctx);
    }
    return out;
  }
  return value;
}

function resolveEligibilityStrings(value: Eligibility | undefined, ctx: TemplateVarContext): Eligibility | undefined {
  if (!value) return value;
  return resolveDeepStrings(value, ctx) as Eligibility;
}

export async function taskOutput(config: TaskOutputConfig, ctx: TaskOutputCtx): Promise<TaskOutputResult> {
  const daemon = readDaemon(ctx.storageRoot);
  if (!daemon) {
    return { warnings: [`output task: daemon port/token not found in ${ctx.storageRoot}`] };
  }

  const payload: FileTaskInput = {
    prompt: resolveTemplateVars(config.prompt, ctx),
    acceptance_criteria: config.acceptance_criteria ? resolveTemplateVars(config.acceptance_criteria, ctx) : undefined,
    expected_artifacts: config.expected_artifacts,
    eligibility: resolveEligibilityStrings(config.eligibility, ctx),
    kind: config.kind,
    bounds: config.bounds,
    review_eligibility: resolveEligibilityStrings(config.review_eligibility, ctx),
    priority: config.priority,
    requires_review: config.requires_review,
    created_by_kind: 'workflow',
    created_by_id: ctx.workflow.name,
    origin: ctx.workflow.origin ?? null,
  } as FileTaskInput;

  try {
    const res = await fetch(`${daemon.baseUrl}/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemon.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { warnings: [`output task: daemon responded ${res.status}`] };
    }
    const data = (await res.json().catch(() => null)) as { task_id?: string } | null;
    return { warnings: [], taskId: data?.task_id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { warnings: [`output task: ${msg}`] };
  }
}
