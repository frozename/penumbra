import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsWorkflow } from "../../src/loaders/ts.js";

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

const VALID_MODULE_WITH_SCHEMA = `
import type { WorkflowSpec } from '@penumbra/workflows/schema';
const spec: WorkflowSpec = {
  name: 'sample-ts-with-schema',
  description: 'desc',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [{ kind: 'clipboard' }],
  run: { kind: 'ts-function' },
};
export default spec;
export const inputSchema = {
  parse(input: unknown) {
    const raw = input as Record<string, unknown>;
    const keys = Object.keys(raw ?? {});
    const allowed = ['target_ref', 'timeout_ms'];
    const unknown = keys.filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new Error('strict');
    const target_ref = typeof raw?.target_ref === 'string' ? raw.target_ref : 'HEAD';
    const timeout_ms = typeof raw?.timeout_ms === 'number' && raw.timeout_ms > 0 ? raw.timeout_ms : 600000;
    return { target_ref, timeout_ms };
  },
};
export const fn = async (_ctx: unknown, _recall: unknown) => ({ ok: true });
`;

const INVALID_MODULE = `
export default { name: 'BadName_NotKebab', description: '', triggers: [], recall: [], output: [], run: { kind: 'ts-function' } };
`;

test("loads valid TS module + binds fn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsw-"));
  try {
    const path = join(dir, "workflow.ts");
    writeFileSync(path, VALID_MODULE);
    const loaded = await loadTsWorkflow(path);
    const { spec, fn } = loaded;
    expect(spec.name).toBe("sample-ts");
    expect(typeof fn).toBe("function");
    expect("inputSchema" in loaded).toBe(true);
    expect(loaded.inputSchema).toBeUndefined();
    const r = await fn!({}, {});
    expect(r).toEqual({ ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loads optional inputSchema when exported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsw-"));
  try {
    const path = join(dir, "workflow.ts");
    writeFileSync(path, VALID_MODULE_WITH_SCHEMA);
    const loaded = await loadTsWorkflow(path);
    expect(loaded.spec.name).toBe("sample-ts-with-schema");
    expect(loaded.inputSchema).toBeDefined();
    const parsed = loaded.inputSchema!.parse({});
    expect(parsed).toEqual({ target_ref: "HEAD", timeout_ms: 600000 });
    expect(() => loaded.inputSchema!.parse({ extra: true })).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throws on invalid spec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsw-"));
  try {
    const path = join(dir, "workflow.ts");
    writeFileSync(path, INVALID_MODULE);
    await expect(loadTsWorkflow(path)).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-reads file on each load (no module cache)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsw-"));
  try {
    const path = join(dir, "workflow.ts");
    writeFileSync(path, VALID_MODULE);
    const first = await loadTsWorkflow(path);
    expect(first.spec.name).toBe("sample-ts");

    const rewritten = VALID_MODULE.replace(`'sample-ts'`, `'sample-ts-reloaded'`);
    writeFileSync(path, rewritten);
    const second = await loadTsWorkflow(path);
    expect(second.spec.name).toBe("sample-ts-reloaded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
