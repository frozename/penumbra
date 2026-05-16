import { expect, test } from 'bun:test';
import type { ProjectEntry } from '../../../src/projects/schema.js';
import { inspectPromptVsProject } from '../../src/services/dispatch-routing-guard.js';

const registry: ProjectEntry[] = [
  {
    project_id: 'penumbra',
    root_path: '/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be',
  },
  {
    project_id: 'llamactl',
    root_path: '/Volumes/WorkSSD/repos/personal/llamactl',
  },
];

test('same-project absolute paths are ok', () => {
  const result = inspectPromptVsProject({
    prompt: 'touch /Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts',
    project_id: 'penumbra',
    registry,
  });

  expect(result).toEqual({
    status: 'ok',
    mentioned_paths: ['/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts'],
  });
});

test('cross-project absolute paths suggest the matching project', () => {
  const result = inspectPromptVsProject({
    prompt: 'inspect /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
    project_id: 'penumbra',
    registry,
  });

  expect(result).toEqual({
    status: 'mismatch',
    mentioned_paths: ['/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts'],
    missing_in_project: [],
    suggested_project_id: 'llamactl',
  });
});

test('packages references can suggest another project when missing in the resolved project', () => {
  const existsSync = (path: string) => path === '/Volumes/WorkSSD/repos/personal/llamactl/packages/train';
  const result = inspectPromptVsProject(
    {
      prompt: 'work in packages/train and update the pipeline',
      project_id: 'penumbra',
      registry,
    },
    { existsSync },
  );

  expect(result).toEqual({
    status: 'mismatch',
    mentioned_paths: ['packages/train'],
    missing_in_project: ['packages/train'],
    suggested_project_id: 'llamactl',
  });
});

test('no paths mentioned is ok', () => {
  const result = inspectPromptVsProject({
    prompt: 'refactor the parser to be order-independent',
    project_id: 'penumbra',
    registry,
  });

  expect(result).toEqual({
    status: 'ok',
    mentioned_paths: [],
  });
});

test('mentions from multiple projects are ambiguous', () => {
  const result = inspectPromptVsProject({
    prompt: [
      'compare /Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts',
      'with /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
    ].join(' '),
    project_id: 'penumbra',
    registry,
  });

  expect(result).toEqual({
    status: 'mismatch',
    mentioned_paths: [
      '/Volumes/WorkSSD/repos/penumbra-worktrees/8ba3d99d-276b-4bab-a2fd-6aaa739b57be/packages/core/src/index.ts',
      '/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
    ],
    missing_in_project: [],
  });
});

test('suggested project prefers the most frequently mentioned alternate project', () => {
  const result = inspectPromptVsProject({
    prompt: [
      '/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      '/Volumes/WorkSSD/repos/personal/llamactl/src/bar.ts',
    ].join(' '),
    project_id: 'penumbra',
    registry,
  });

  expect(result).toEqual({
    status: 'mismatch',
    mentioned_paths: [
      '/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      '/Volumes/WorkSSD/repos/personal/llamactl/src/bar.ts',
    ],
    missing_in_project: [],
    suggested_project_id: 'llamactl',
  });
});
