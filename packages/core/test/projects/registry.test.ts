import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultProjectRegistryPath,
  getGithubRepo,
  loadProjectRegistry,
  ProjectRegistryDuplicateId,
  ProjectRegistryParseError,
} from '../../src/projects/registry.js';
import { writeBootstrapRegistry } from './registry-fixtures.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

test('bootstrap parse loads five entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = writeBootstrapRegistry(dir);

  const registry = loadProjectRegistry(path);
  expect(registry.list()).toHaveLength(5);
  expect(registry.get('sirius')?.root_path).toBe('/tmp/sirius');
  expect(registry.has('penumbra')).toBe(true);
  expect(registry.has('nope')).toBe(false);
});

test('duplicate id throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
  - project_id: penumbra
    root_path: /tmp/penumbra-2
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryDuplicateId);
  try {
    loadProjectRegistry(path);
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectRegistryDuplicateId);
    expect((err as ProjectRegistryDuplicateId).id).toBe('penumbra');
  }
});

test('malformed yaml throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(path, 'projects: [\n  - not valid yaml\n');

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test('missing file returns empty registry and warns once', () => {
  const path = join(tmpdir(), `penumbra-missing-${Date.now()}-${Math.random()}.yaml`);
  const warn = mock(() => {});
  const originalWarn = console.warn;
  console.warn = warn;
  try {
    const first = loadProjectRegistry(path);
    const second = loadProjectRegistry(path);
    expect(first.list()).toHaveLength(0);
    expect(first.get('penumbra')).toBeUndefined();
    expect(second.list()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    console.warn = originalWarn;
  }
});

test('bad project_id format throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(
    path,
    `projects:
  - project_id: CAPITALIZED
    root_path: /tmp/capitalized
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test('gh_repo parses owner/name form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    gh_repo: acordeiro/penumbra
`,
  );

  const registry = loadProjectRegistry(path);
  expect(getGithubRepo(registry.get('penumbra'))).toBe('acordeiro/penumbra');
});

test('invalid gh_repo format throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    gh_repo: acordeiro
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test('remote github form parses and helper prefers remote repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:
      kind: github
      repo: acordeiro/penumbra
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get('penumbra')?.remote).toEqual({ kind: 'github', repo: 'acordeiro/penumbra' });
  expect(getGithubRepo(registry.get('penumbra'))).toBe('acordeiro/penumbra');
});

test('both gh_repo and remote throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    gh_repo: acordeiro/penumbra
    remote:
      kind: github
      repo: acordeiro/penumbra
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow('declares both legacy gh_repo and remote; pick one');
});

test('invalid remote github repo format throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-project-registry-'));
  dirs.push(dir);
  const path = join(dir, 'projects.yaml');
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:
      kind: github
      repo: acordeiro
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test('default registry path points at home .penumbra/projects.yaml', () => {
  expect(defaultProjectRegistryPath()).toMatch(/\.penumbra[\\/]+projects\.yaml$/);
});
