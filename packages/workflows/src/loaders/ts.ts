import { WorkflowSpecSchema, type WorkflowSpec } from '../schema.js';

export type LoadedTsWorkflow = {
  spec: WorkflowSpec;
  fn?: (ctx: unknown, recall: unknown) => Promise<unknown>;
};

export async function loadTsWorkflow(path: string): Promise<LoadedTsWorkflow> {
  const mod = await import(path);
  const rawSpec = mod.default;
  if (!rawSpec || typeof rawSpec !== 'object') {
    throw new Error(`workflow ${path}: missing default export`);
  }
  const spec = WorkflowSpecSchema.parse(rawSpec);
  const fn = (mod.fn ?? mod.run ?? undefined) as LoadedTsWorkflow['fn'];
  if (spec.run.kind === 'ts-function' && !fn) {
    throw new Error(`workflow ${path}: ts-function run requires exported \`fn\` (or \`run\`)`);
  }
  return { spec, fn };
}
