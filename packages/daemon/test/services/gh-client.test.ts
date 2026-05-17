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

  test('commentIssue invokes gh issue comment and returns parsed URL from stdout', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return {
        stdout: 'https://github.com/acordeiro/penumbra/issues/1#issuecomment-123456789\n',
        stderr: '',
        exitCode: 0,
      };
    };
    const client = createGhCliClient({ exec });
    const out = await client.commentIssue('acordeiro/penumbra', 1, 'hello');

    expect(calls[0]).toEqual([
      'issue',
      'comment',
      '1',
      '--repo',
      'acordeiro/penumbra',
      '--body',
      'hello',
    ]);
    expect(out).toEqual({
      comment_url: 'https://github.com/acordeiro/penumbra/issues/1#issuecomment-123456789',
    });
  });

  test('listComments invokes gh api with since filter and maps comments from raw paginated output', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify([
          [
            {
              id: 9001,
              user: { login: 'octocat' },
              body: 'Looks good',
              created_at: '2026-05-08T17:00:00Z',
              html_url: 'https://github.com/acordeiro/penumbra/issues/1#issuecomment-9001',
            },
          ],
          [
            {
              id: '9002',
              user: {},
              body: null,
              created_at: null,
              url: 'https://github.com/acordeiro/penumbra/issues/1#issuecomment-9002',
            },
          ],
        ]),
        stderr: '',
        exitCode: 0,
      };
    };
    const client = createGhCliClient({ exec });
    const out = await client.listComments('acordeiro/penumbra', 1, { since: '2026-05-08T16:00:00.000Z' });

    expect(calls[0]).toEqual([
      'api',
      'repos/acordeiro/penumbra/issues/1/comments?since=2026-05-08T16%3A00%3A00.000Z',
      '--paginate',
      '--slurp',
    ]);
    expect(out).toEqual([
      {
        id: '9001',
        author_login: 'octocat',
        body: 'Looks good',
        created_at: '2026-05-08T17:00:00Z',
        url: 'https://github.com/acordeiro/penumbra/issues/1#issuecomment-9001',
      },
      {
        id: '9002',
        author_login: '',
        body: '',
        created_at: '',
        url: 'https://github.com/acordeiro/penumbra/issues/1#issuecomment-9002',
      },
    ]);
  });

  test('getAuthenticatedLogin reads login via gh api user', async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return {
        stdout: 'penumbra-bot\n',
        stderr: '',
        exitCode: 0,
      };
    };
    const client = createGhCliClient({ exec });
    const login = await client.getAuthenticatedLogin?.();

    expect(calls[0]).toEqual([
      'api',
      'user',
      '--jq',
      '.login',
    ]);
    expect(login).toBe('penumbra-bot');
  });
});
