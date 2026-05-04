import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTsWorkflow } from '../../src/loaders/ts.js';

const VALID_MODULE = `
import type { WorkflowSpec } from '@penumbra/workflows/schema';
const spec: WorkflowSpec = {
  name: 'sample-ts',
  description: 'desc',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [{ kind: 'clipboard' }],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn = async (_ctx: unknown, _recall: unknown) => ({ ok: true });
`;

const INVALID_MODULE = `
export default { name: 'BadName_NotKebab', description: '', triggers: [], recall: [], output: [], run: { kind: 'ts-function' } };
`;

test('loads valid TS module + binds fn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsw-'));
  try {
    const path = join(dir, 'workflow.ts');
    writeFileSync(path, VALID_MODULE);
    const { spec, fn } = await loadTsWorkflow(path);
    expect(spec.name).toBe('sample-ts');
    expect(typeof fn).toBe('function');
    const r = await fn!({}, {});
    expect(r).toEqual({ ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('throws on invalid spec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsw-'));
  try {
    const path = join(dir, 'workflow.ts');
    writeFileSync(path, INVALID_MODULE);
    await expect(loadTsWorkflow(path)).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
