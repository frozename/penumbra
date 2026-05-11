import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  applyWorktreeOverride,
  rewriteWorktreeHandoffMessage,
} from '../../src/worker/worktree-integration.js';
import type { AgentChatConfig } from '../../src/config/types.js';
import { WorktreeManager, type WorktreeHandle } from '@penumbra/core';

const diskFullError = new Error('disk full');
const exec = promisify(execCb);

const baseConfig = {
  agents: [
    {
      name: 'gemini',
      adapter: 'gemini-cli',
      options: { command: 'gemini' },
      roles: [],
      auto_approve_to: [],
      pricing_mode: 'api',
    },
    {
      name: 'http',
      adapter: 'openai-compat-http',
      options: { baseUrl: 'url', model: 'm' },
      roles: [],
      auto_approve_to: [],
      pricing_mode: 'api',
    },
  ],
  default_roles: {},
} as unknown as AgentChatConfig;

const mainRepoPath = process.cwd();

function makeMockWorktreeManager(): WorktreeManager {
  const handles = new Map<string, WorktreeHandle>();

  return {
    async createWorktree(id: string, opts?: { baseRef?: string; project_id?: string }) {
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
      if (opts?.baseRef) {
        (handle as any).baseRef = opts.baseRef;
      }
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

test('Dispatch with use_worktree: false and project_id -> agent cwd points at project root', async () => {
  const wtm = {
    ...makeMockWorktreeManager(),
    projectRootFor: (id?: string) => (id === 'llamactl' ? '/repos/llamactl' : undefined),
  } as unknown as WorktreeManager;
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h3-root', to_agent: 'gemini', use_worktree: false, project_id: 'llamactl' },
    baseConfig,
    '/storage',
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect((overrideConfig.agents.find((a) => a.name === 'gemini') as any).options.cwd).toBe('/repos/llamactl');
});

test('Dispatch with use_worktree: true on non-worktree-capable adapter and project_id -> agent cwd points at project root', async () => {
  const wtm = {
    ...makeMockWorktreeManager(),
    projectRootFor: (id?: string) => (id === 'llamactl' ? '/repos/llamactl' : undefined),
  } as unknown as WorktreeManager;
  const { overrideConfig, handle } = await applyWorktreeOverride(
    { handoff_id: 'h3-root-nonwt', to_agent: 'http', use_worktree: true, project_id: 'llamactl' },
    baseConfig,
    '/storage',
    wtm,
    mainRepoPath,
  );
  expect(handle).toBeNull();
  expect((overrideConfig.agents.find((a) => a.name === 'http') as any).options.cwd).toBe('/repos/llamactl');
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
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'penumbra-wt-repo-'));
  await exec('git init -b main', { cwd: repoDir });
  await exec('git config user.email "test@example.com"', { cwd: repoDir });
  await exec('git config user.name "test"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# one\n');
  await exec('git add README.md && git commit -m "one"', { cwd: repoDir });
  const manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir });
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
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('applyWorktreeOverride forwards branch_base to createWorktree', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'penumbra-wt-integration-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'penumbra-wt-repo-'));
  await exec('git init -b main', { cwd: repoDir });
  await exec('git config user.email "test@example.com"', { cwd: repoDir });
  await exec('git config user.name "test"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# one\n');
  await exec('git add README.md && git commit -m "one"', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# two\n');
  await exec('git add README.md && git commit -m "two"', { cwd: repoDir });
  const manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir });
  const handoffId = `singleton-${Date.now()}-branch`;

  try {
    const spyManager = {
      ...manager,
      createWorktree: async (id: string, opts?: { baseRef?: string; project_id?: string }) => {
        expect(id).toBe(handoffId);
        expect(opts?.baseRef).toBe('agent/dep-tip');
        return manager.createWorktree(id, { ...opts, baseRef: 'HEAD~1' });
      },
    } as unknown as WorktreeManager;
    const { handle } = await applyWorktreeOverride(
      { handoff_id: handoffId, to_agent: 'gemini', use_worktree: true, branch_base: 'agent/dep-tip' },
      baseConfig,
      '/storage',
      spyManager,
      mainRepoPath,
    );

    expect(handle).not.toBeNull();
  } finally {
    await manager.teardownWorktree(handoffId, true).catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
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
