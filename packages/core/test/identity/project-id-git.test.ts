import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProjectId } from '../../src/identity/project-id.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-pid-git-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://example.com/foo/bar.git'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '#');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('resolves a git repo at the root to kind=git with deterministic id', () => {
  const r = resolveProjectId({ cwd: dir });
  expect(r.kind).toBe('git');
  expect(r.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test('resolves a subdirectory with relpath appended', () => {
  const sub = join(dir, 'packages', 'x');
  mkdirSync(sub, { recursive: true });
  const r = resolveProjectId({ cwd: sub });
  expect(r.kind).toBe('git');
  expect(r.project_id).toMatch(/:packages\/x$/);
});

test('two cwds in the same repo produce the same project-id prefix', () => {
  const a = resolveProjectId({ cwd: dir });
  mkdirSync(join(dir, 'sub'));
  const b = resolveProjectId({ cwd: join(dir, 'sub') });
  if (a.kind !== 'git' || b.kind !== 'git') throw new Error('expected git resolution');
  expect(a.project_id.split(':')[0]).toBe(b.project_id.split(':')[0]);
});
