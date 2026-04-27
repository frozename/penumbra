import { expect, test, spyOn } from 'bun:test';
import { applyWorktreeOverride } from '../../src/worker/worktree-integration.js';
import type { AgentChatConfig } from '../../src/config/types.js';
import { WorktreeManager } from '@penumbra/core';

const diskFullError = new Error('disk full');

spyOn(WorktreeManager.prototype, 'createWorktree').mockImplementation(async (id: string) => {
  if (id === 'fail') throw diskFullError;
  if (id === 'string-fail') throw 'disk full';
  return { 
    handoffId: id, branchName: `agent/${id}`, createdAt: '', status: 'created',
    path: `/fake/worktree/${id}`, storageRoot: `/fake/worktree/${id}/.test-storage` 
  };
});

const baseConfig: AgentChatConfig = {
  agents: [
    { name: 'gemini', adapter: 'gemini-cli', options: { command: 'gemini' } },
    { name: 'http', adapter: 'openai-compat-http', options: { baseUrl: 'url', model: 'm' } },
  ],
  default_roles: {},
  system_prompt: '',
};

const wtm = new WorktreeManager();

test('Dispatch with adapter kind gemini-cli -> worktree created, cwd/env injected', async () => {
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h1', to_agent: 'gemini', use_worktree: true },
    baseConfig,
    '/storage',
    wtm
  );
  expect(handle).not.toBeNull();
  expect(handle?.path).toBe('/fake/worktree/h1');
  const agent = overrideConfig.agents.find((a) => a.name === 'gemini');
  expect((agent?.options as any).cwd).toBe('/fake/worktree/h1');
  expect((agent?.options as any).env.PENUMBRA_STORAGE_ROOT).toBe('/fake/worktree/h1/.test-storage');
});

test('Dispatch with adapter kind openai-compat-http -> NO worktree created', async () => {
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h2', to_agent: 'http', use_worktree: true },
    baseConfig,
    '/storage',
    wtm
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
});

test('Dispatch with use_worktree: false -> NO worktree', async () => {
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h3', to_agent: 'gemini', use_worktree: false },
    baseConfig,
    '/storage',
    wtm
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
});

test('Worktree creation throws -> propagates error', async () => {
  try {
    await applyWorktreeOverride(
      { handoff_id: 'fail', to_agent: 'gemini', use_worktree: true },
      baseConfig,
      '/storage',
      wtm
    );
    throw new Error('expected worktree creation to fail');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('worktree creation failed for fail: disk full');
    expect((err as any).cause).toBe(diskFullError);
  }
});

test('Non-Error worktree failure is wrapped as an Error cause', async () => {
  try {
    await applyWorktreeOverride(
      { handoff_id: 'string-fail', to_agent: 'gemini', use_worktree: true },
      baseConfig,
      '/storage',
      wtm
    );
    throw new Error('expected worktree creation to fail');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('worktree creation failed for string-fail: disk full');
    expect((err as any).cause).toBeInstanceOf(Error);
    expect((err as any).cause.message).toBe('disk full');
  }
});
