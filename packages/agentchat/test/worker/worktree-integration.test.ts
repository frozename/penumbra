import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyWorktreeOverride,
  rewriteWorktreeHandoffMessage,
} from '../../src/worker/worktree-integration.js';
import type { AgentChatConfig } from '../../src/config/types.js';
import { WorktreeManager, type WorktreeHandle } from '@penumbra/core';

const diskFullError = new Error('disk full');

const baseConfig: AgentChatConfig = {
  agents: [
    { name: 'gemini', adapter: 'gemini-cli', options: { command: 'gemini' } },
    { name: 'http', adapter: 'openai-compat-http', options: { baseUrl: 'url', model: 'm' } },
  ],
  default_roles: {},
  system_prompt: '',
};

const mainRepoPath = process.cwd();

function makeMockWorktreeManager(): WorktreeManager {
  const handles = new Map<string, WorktreeHandle>();

  return {
    async createWorktree(id: string) {
      if (id === 'fail') throw diskFullError;
      if (id === 'string-fail') throw 'disk full';

      const handle: WorktreeHandle = {
        handoffId: id,
        branchName: `agent/${id}`,
        createdAt: '',
        status: 'created',
        path: `/fake/worktree/${id}`,
        storageRoot: `/fake/worktree/${id}/.test-storage`,
      };
      handles.set(id, handle);
      return handle;
    },
    getWorktree(id: string) {
      return handles.get(id) ?? null;
    },
  } as unknown as WorktreeManager;
}

test('Dispatch with adapter kind gemini-cli -> worktree created, cwd/env injected', async () => {
  const wtm = makeMockWorktreeManager();
  const { overrideConfig, handle, worktreePromptRewrite } = await applyWorktreeOverride(
    { handoff_id: 'h1', to_agent: 'gemini', use_worktree: true },
    baseConfig,
    '/storage',
    wtm,
    mainRepoPath,
  );
  expect(worktreePromptRewrite).toEqual({
    mainRepoPath,
    worktreePath: '/fake/worktree/h1',
    guardText:
      'This dispatch is isolated to the assigned worktree only.\n' +
      'Work only in: /fake/worktree/h1\n' +
      'Do not read, edit, or commit in the shared main checkout.',
  });
  expect(handle).not.toBeNull();
  expect(handle?.path).toBe('/fake/worktree/h1');
  const agent = overrideConfig.agents.find((a) => a.name === 'gemini');
  expect((agent?.options as any).cwd).toBe('/fake/worktree/h1');
  expect((agent?.options as any).env.PENUMBRA_STORAGE_ROOT).toBe('/fake/worktree/h1/.test-storage');
});

test('Dispatch with adapter kind openai-compat-http -> NO worktree created', async () => {
  const wtm = makeMockWorktreeManager();
  const { overrideConfig, handle, worktreePromptRewrite } = await applyWorktreeOverride(
    { handoff_id: 'h2', to_agent: 'http', use_worktree: true },
    baseConfig,
    '/storage',
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
  expect(worktreePromptRewrite).toBeNull();
});

test('Dispatch with use_worktree: false -> NO worktree', async () => {
  const wtm = makeMockWorktreeManager();
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h3', to_agent: 'gemini', use_worktree: false },
    baseConfig,
    '/storage',
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
});

test('Worktree creation throws -> propagates error', async () => {
  const wtm = makeMockWorktreeManager();
  try {
    await applyWorktreeOverride(
      { handoff_id: 'fail', to_agent: 'gemini', use_worktree: true },
      baseConfig,
      '/storage',
      wtm,
      mainRepoPath,
    );
    throw new Error('expected worktree creation to fail');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('worktree creation failed for fail: disk full');
    expect((err as any).cause).toBe(diskFullError);
  }
});

test('Non-Error worktree failure is wrapped as an Error cause', async () => {
  const wtm = makeMockWorktreeManager();
  try {
    await applyWorktreeOverride(
      { handoff_id: 'string-fail', to_agent: 'gemini', use_worktree: true },
      baseConfig,
      '/storage',
      wtm,
      mainRepoPath,
    );
    throw new Error('expected worktree creation to fail');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('worktree creation failed for string-fail: disk full');
    expect((err as any).cause).toBeInstanceOf(Error);
    expect((err as any).cause.message).toBe('disk full');
  }
});

test('applyWorktreeOverride creates the worktree on the passed manager instance', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'penumbra-wt-integration-'));
  const manager = new WorktreeManager({ rootDir, mainRepoDir: process.cwd() });
  const handoffId = `singleton-${Date.now()}`;

  try {
    const { handle } = await applyWorktreeOverride(
      { handoff_id: handoffId, to_agent: 'gemini', use_worktree: true },
      baseConfig,
      '/storage',
      manager,
      mainRepoPath,
    );

    expect(handle).not.toBeNull();
    expect(manager.getWorktree(handoffId)).toEqual(handle);
  } finally {
    await manager.teardownWorktree(handoffId, true).catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rewriteWorktreeHandoffMessage rewrites main-repo paths and adds isolation guard', () => {
  const rewritten = rewriteWorktreeHandoffMessage(
    `Please update ${mainRepoPath}/src/index.ts and /tmp`,
    {
      mainRepoPath,
      worktreePath: '/fake/worktree/h1',
      guardText:
        `This dispatch is isolated to the assigned worktree only.\n` +
        `Work only in: /fake/worktree/h1\n` +
        'Do not read, edit, or commit in the shared main checkout.',
    },
  );
  const [rewrittenMessageBody] = rewritten.split('\n\n', 2);

  expect(rewritten).toContain('/fake/worktree/h1/src/index.ts');
  expect(rewritten).toContain('/fake/worktree/h1');
  expect(rewrittenMessageBody).not.toContain(mainRepoPath);
  expect(rewritten).toContain('This dispatch is isolated to the assigned worktree only.');
  expect(rewritten).toContain('Do not read, edit, or commit in the shared main checkout.');
});
