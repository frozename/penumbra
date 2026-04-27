import { expect, test, mock, spyOn } from 'bun:test';
import { applyWorktreeOverride } from '../../src/worker/worktree-integration.js';
import type { AgentChatConfig } from '../../src/config/types.js';
import { WorktreeManager } from '../../src/worktree/manager.js';

spyOn(WorktreeManager.prototype, 'createWorktree').mockImplementation(async (id: string) => {
  if (id === 'fail') throw new Error('disk full');
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

test('Dispatch with adapter kind gemini-cli -> worktree created, cwd/env injected', async () => {
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h1', to_agent: 'gemini', use_worktree: true },
    baseConfig,
    '/storage'
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
    '/storage'
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
});

test('Dispatch with use_worktree: false -> NO worktree', async () => {
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h3', to_agent: 'gemini', use_worktree: false },
    baseConfig,
    '/storage'
  );
  expect(handle).toBeNull();
  expect(overrideConfig).toBe(baseConfig);
});

test('Worktree creation throws -> propagates error', async () => {
  await expect(
    applyWorktreeOverride(
      { handoff_id: 'fail', to_agent: 'gemini', use_worktree: true },
      baseConfig,
      '/storage'
    )
  ).rejects.toThrow('disk full');
});
