import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultProjectRegistryPath,
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

test('default registry path points at home .penumbra/projects.yaml', () => {
  expect(defaultProjectRegistryPath()).toMatch(/\.penumbra[\\/]+projects\.yaml$/);
});
