import { expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveProjectScope } from '../../src/identity/project-resolver.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

let dir = '';

function mkGitDir() {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-project-resolver-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'https://example.com/foo/bar.git'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '#\n');
}

beforeEach(() => {
  mkGitDir();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('registered repo_root returns kind=registered with friendly name', () => {
  const gitRoot = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    .stdout.trim();
  const registry = new ProjectRegistry(new Map([
    ['penumbra', { project_id: 'penumbra', root_path: gitRoot || dir }],
  ]));
  const scope = resolveProjectScope({ cwd: dir, registry });
  expect(scope.kind).toBe('registered');
  if (scope.kind === 'registered') {
    expect(scope.project_id).toBe('penumbra');
  }
});

test('git repo with no registry match returns kind=synthetic', () => {
  const scope = resolveProjectScope({ cwd: dir, registry: new ProjectRegistry(new Map()) });
  expect(scope.kind).toBe('synthetic');
  expect(scope.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test('non-git cwd returns kind=global with null project_id', () => {
  const nonGit = mkdtempSync(join(tmpdir(), 'penumbra-project-resolver-non-git-'));
  try {
    const scope = resolveProjectScope({ cwd: nonGit });
    expect(scope.kind).toBe('global');
    expect(scope.project_id).toBeNull();
    expect(scope.repo_root).toBeNull();
  } finally {
    rmSync(nonGit, { recursive: true, force: true });
  }
});

test('registry.list() throwing falls back to synthetic', () => {
  const registry = {
    list: mock(() => {
      throw new Error('boom');
    }),
  };
  const scope = resolveProjectScope({ cwd: dir, registry });
  expect(scope.kind).toBe('synthetic');
  expect(scope.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});

test('registry undefined defaults to synthetic for git repos', () => {
  const scope = resolveProjectScope({ cwd: dir, registry: undefined });
  expect(scope.kind).toBe('synthetic');
  expect(scope.project_id).toMatch(/^[0-9a-f]{16}:\.$/);
});
