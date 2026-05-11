import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { findProjectIdByCwd } from '../../src/projects/registry-cwd.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function mkdir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function registry(entries: Array<{ project_id: string; root_path: string }>): ProjectRegistry {
  const m = new Map<string, { project_id: string; root_path: string }>();
  for (const e of entries) m.set(e.project_id, e);
  return new ProjectRegistry(m);
}

test('exact-match cwd resolves to its project_id', () => {
  const llamactl = mkdir('penumbra-test-llamactl-');
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, llamactl)).toBe('llamactl');
});

test('nested cwd inside a registered root resolves to that root', () => {
  const llamactl = mkdir('penumbra-test-llamactl-');
  const sub = join(llamactl, 'packages/cli');
  mkdirSync(sub, { recursive: true });
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, sub)).toBe('llamactl');
});

test('unregistered cwd returns undefined', () => {
  const other = mkdir('penumbra-test-other-');
  const llamactl = mkdir('penumbra-test-llamactl-');
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, other)).toBeUndefined();
});

test('sibling-but-not-child returns undefined', () => {
  const parent = mkdir('penumbra-test-parent-');
  const a = join(parent, 'a');
  const b = join(parent, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const r = registry([{ project_id: 'a', root_path: a }]);
  expect(findProjectIdByCwd(r, b)).toBeUndefined();
});

test('longest-prefix wins when multiple roots are nested', () => {
  const outer = mkdir('penumbra-test-outer-');
  const inner = join(outer, 'inner');
  mkdirSync(inner);
  const r = registry([
    { project_id: 'outer', root_path: outer },
    { project_id: 'inner', root_path: inner },
  ]);
  expect(findProjectIdByCwd(r, inner)).toBe('inner');
  expect(findProjectIdByCwd(r, outer)).toBe('outer');
});

test('symlinked cwd realpath-normalizes before comparison', () => {
  const llamactl = mkdir('penumbra-test-llamactl-');
  const linkParent = mkdir('penumbra-test-link-');
  const link = join(linkParent, 'link');
  symlinkSync(llamactl, link);
  const r = registry([{ project_id: 'llamactl', root_path: llamactl }]);
  expect(findProjectIdByCwd(r, link)).toBe('llamactl');
});

test('empty registry returns undefined', () => {
  const cwd = mkdir('penumbra-test-empty-');
  const r = registry([]);
  expect(findProjectIdByCwd(r, cwd)).toBeUndefined();
});
