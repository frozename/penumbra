import { describe, expect, test } from 'bun:test';
import { createGhCliClient, type GhExec } from '../../src/services/gh-client.js';

describe('createGhCliClient', () => {
  test('createIssue returns number/url from gh issue create stdout URL', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return {
        stdout: 'https://github.com/acordeiro/penumbra/issues/42\n',
        stderr: '',
        exitCode: 0,
      };
    };
    const client = createGhCliClient({ exec });

    const out = await client.createIssue({
      repo: 'acordeiro/penumbra',
      title: 'Task title',
      body: 'Task body',
      labels: ['tasks', 'phase-2'],
      assignees: ['acordeiro'],
    });

    expect(calls).toEqual([[
      'issue',
      'create',
      '--repo',
      'acordeiro/penumbra',
      '--title',
      'Task title',
      '--body',
      'Task body',
      '--label',
      'tasks',
      '--label',
      'phase-2',
      '--assignee',
      'acordeiro',
    ]]);
    expect(out).toEqual({
      number: 42,
      url: 'https://github.com/acordeiro/penumbra/issues/42',
    });
  });

  test('createIssue throws if gh output has no issue URL', async () => {
    const exec: GhExec = async () => ({
      stdout: 'created\n',
      stderr: '',
      exitCode: 0,
    });
    const client = createGhCliClient({ exec });

    await expect(client.createIssue({
      repo: 'acordeiro/penumbra',
      title: 'Task title',
    })).rejects.toThrow('did not print an issue URL');
  });
});
