import { WorkflowSpecSchema, type WorkflowSpec } from '../schema.js';
import type { WorkflowFn } from '../exec.js';
import type { ZodTypeAny } from 'zod';

export type LoadedTsWorkflow = {
  spec: WorkflowSpec;
  fn?: WorkflowFn;
  inputSchema?: ZodTypeAny;
};

export async function loadTsWorkflow(path: string): Promise<LoadedTsWorkflow> {
  const mod = await import(path);
  const rawSpec = mod.default;
  if (!rawSpec || typeof rawSpec !== 'object') {
    throw new Error(`workflow ${path}: missing default export`);
  }
  const spec = WorkflowSpecSchema.parse(rawSpec);
  const fn = (mod.fn ?? mod.run ?? undefined) as LoadedTsWorkflow['fn'];
  const inputSchema = mod.inputSchema as LoadedTsWorkflow['inputSchema'];
  if (inputSchema !== undefined && typeof inputSchema?.parse !== 'function') {
    throw new Error(`workflow ${path}: \`inputSchema\` must be a zod schema`);
  }
  if (spec.run.kind === 'ts-function' && !fn) {
    throw new Error(`workflow ${path}: ts-function run requires exported \`fn\` (or \`run\`)`);
  }
  return { spec, fn, inputSchema };
}
