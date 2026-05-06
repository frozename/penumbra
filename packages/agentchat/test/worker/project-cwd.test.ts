import { expect, test } from 'bun:test';
import { resolveDispatchCwd, UnknownProjectError } from '../../src/worker/project-cwd.js';

test('resolveDispatchCwd uses the default cwd when project_id is unset', () => {
  const homeCwd = process.cwd();

  const cwd = resolveDispatchCwd({
    project_id: undefined,
    defaultCwd: homeCwd,
    projectRegistry: { get: () => undefined },
  });

  expect(cwd).toBe(homeCwd);
});

test("resolveDispatchCwd uses the registry root for project_id='sirius'", () => {
  const cwd = resolveDispatchCwd({
    project_id: 'sirius',
    defaultCwd: process.cwd(),
    projectRegistry: {
      get: (projectId: string) =>
        projectId === 'sirius'
          ? { project_id: 'sirius', root_path: '/tmp/fake-sirius' }
          : undefined,
    },
  });

  expect(cwd).toBe('/tmp/fake-sirius');
});

test('resolveDispatchCwd throws UnknownProjectError for an unknown project_id', () => {
  expect(() =>
    resolveDispatchCwd({
      project_id: 'bogus',
      defaultCwd: process.cwd(),
      projectRegistry: { get: () => undefined },
    }),
  ).toThrow(UnknownProjectError);
});
