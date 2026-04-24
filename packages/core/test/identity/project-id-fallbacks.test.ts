import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectId } from '../../src/identity/project-id.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'penumbra-pid-fb-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('declared wins over everything', () => {
  writeFileSync(join(dir, '.penumbra-project'), 'marker-uuid');
  const r = resolveProjectId({ cwd: dir, declaredProjectId: 'declared-xyz' });
  expect(r.kind).toBe('declared');
  if (r.kind === 'declared') expect(r.project_id).toBe('declared-xyz');
});

test('marker file used when no git remote and no declared', () => {
  writeFileSync(join(dir, '.penumbra-project'), 'marker-uuid-42');
  const r = resolveProjectId({ cwd: dir });
  expect(r.kind).toBe('marker');
  if (r.kind === 'marker') expect(r.project_id).toBe('marker-uuid-42');
});

test('marker is found by walking up from subdirectory', () => {
  writeFileSync(join(dir, '.penumbra-project'), 'parent-marker');
  const sub = join(dir, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const r = resolveProjectId({ cwd: sub });
  expect(r.kind).toBe('marker');
  if (r.kind === 'marker') expect(r.project_id).toBe('parent-marker');
});

test('quarantine when nothing matches', () => {
  const r = resolveProjectId({ cwd: dir });
  expect(r.kind).toBe('quarantine');
  expect(r.project_id).toBeNull();
});
