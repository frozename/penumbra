import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';
import { WorktreeManager } from '../../src/worktree/manager.js';

const exec = promisify(execCb);

async function setupTempRepo(prefix: string): Promise<string> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await exec(`git init -b main`, { cwd: repoDir });
  await exec(`git config user.email "test@example.com"`, { cwd: repoDir });
  await exec(`git config user.name "test"`, { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  await exec(`git add . && git commit -m "init"`, { cwd: repoDir });
  return repoDir;
}

describe('WorktreeManager — project parameterization', () => {
  let homeRoot: string;
  let homeRepo: string;
  let counter = 0;

  beforeEach(async () => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'penumbra-wt-home-'));
    homeRepo = await setupTempRepo('penumbra-wt-homerepo-');
  });

  afterEach(() => {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(homeRepo, { recursive: true, force: true });
  });

  function nextHandoff(): string {
    return `wt-test-${Date.now()}-${++counter}`;
  }

  it('creates and tears down under home base when no project_id provided', async () => {
    const manager = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id);

    expect(handle.path).toBe(path.join(homeRoot, id));
    expect(handle.projectId).toBeUndefined();
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.existsSync(path.join(handle.path, '.git'))).toBe(true);

    await manager.teardownWorktree(id, true);
    expect(fs.existsSync(handle.path)).toBe(false);
    expect(manager.getWorktree(id)).toBeNull();
  });

  it('creates and prunes under <project_root>-worktrees when project_id resolves', async () => {
    const siriusRepo = await setupTempRepo('penumbra-wt-sirius-');
    const expectedBase = `${siriusRepo}-worktrees`;

    try {
      const manager = new WorktreeManager({
        rootDir: homeRoot,
        mainRepoDir: homeRepo,
        resolveProjectRoot: (id) => (id === 'sirius' ? siriusRepo : undefined),
      });

      const id = nextHandoff();
      const handle = await manager.createWorktree(id, { project_id: 'sirius' });

      expect(handle.path).toBe(path.join(expectedBase, id));
      expect(handle.projectId).toBe('sirius');
      expect(fs.existsSync(handle.path)).toBe(true);
      // Must not have been created in the home base.
      expect(fs.existsSync(path.join(homeRoot, id))).toBe(false);

      // Prune via teardown — must clean up under the per-project base.
      await manager.teardownWorktree(id, true);
      expect(fs.existsSync(handle.path)).toBe(false);
      expect(manager.getWorktree(id, 'sirius')).toBeNull();
    } finally {
      fs.rmSync(siriusRepo, { recursive: true, force: true });
      fs.rmSync(expectedBase, { recursive: true, force: true });
    }
  });
});
