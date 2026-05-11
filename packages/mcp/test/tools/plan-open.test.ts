import { afterEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { planOpenHandler } from '../../src/tools/plan-open.js';

const createdRoots = new Set<string>();

afterEach(async () => {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

test('plan_open materializes a minimal plan file and calls daemon.planStart with it', async () => {
  let capturedPath = '';
  const daemon = {
    planStart: async ({ file_path }: { file_path: string }) => {
      capturedPath = file_path;
      return { plan_id: 'plan-1', status: 'running' };
    },
  };
  const handler = planOpenHandler(daemon as any);
  const out = await handler({
    goal: 'Ship maestro capability introspection',
    steps: ['Add daemon route', 'Add MCP wrapper'],
  });
  expect(out.plan_id).toBe('plan-1');
  expect(out.status).toBe('running');
  expect(capturedPath.length).toBeGreaterThan(0);

  createdRoots.add(dirname(capturedPath));
  const content = await readFile(capturedPath, 'utf8');
  expect(content).toContain('home_project: penumbra');
  expect(content).toContain('Ship maestro capability introspection');
  expect(content).toContain('Add daemon route');
  expect(content).toContain('Add MCP wrapper');
});
