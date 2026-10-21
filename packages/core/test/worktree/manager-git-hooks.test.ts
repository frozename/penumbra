import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { type WorktreeCommandRunner, WorktreeManager } from "@src/worktree/manager.js";

const execFile = promisify(execFileCb);

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return await execFile("git", args, {
    cwd,
    env,
    encoding: "utf8",
  });
}

interface HooksRepo {
  repoDir: string;
  isolatedEnv: NodeJS.ProcessEnv;
  isolatedHome: string;
}

async function setupHooksRepo(prefix: string, opts: { hooksPath?: string }): Promise<HooksRepo> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  const isolatedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
  };

  await git(repoDir, ["init", "-b", "main"], isolatedEnv);
  await git(repoDir, ["config", "user.name", "Hook Tester"], isolatedEnv);
  await git(repoDir, ["config", "user.email", "hook@example.com"], isolatedEnv);

  fs.writeFileSync(path.join(repoDir, "package.json"), '{"name":"hooks-fixture","private":true}');

  const huskyDir = path.join(repoDir, ".husky");
  fs.mkdirSync(huskyDir, { recursive: true });
  fs.writeFileSync(path.join(huskyDir, "pre-commit"), "#!/usr/bin/env sh\nexit 1\n");
  fs.chmodSync(path.join(huskyDir, "pre-commit"), 0o755);

  await git(repoDir, ["add", "."], isolatedEnv);
  await git(repoDir, ["commit", "-m", "init"], isolatedEnv);

  if (opts.hooksPath !== undefined) {
    await git(repoDir, ["config", "core.hooksPath", opts.hooksPath], isolatedEnv);
  }

  return { repoDir, isolatedEnv, isolatedHome };
}

function isolatedRunner(env: NodeJS.ProcessEnv): WorktreeCommandRunner {
  return (cmd, args, opts) => {
    if (cmd === "bun") {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    return execFile(cmd, args, {
      ...opts,
      env: env,
      encoding: opts?.encoding ?? "utf8",
    });
  };
}

describe("WorktreeManager git hooks signal", () => {
  let homeRoot: string;
  let repo: HooksRepo;
  let originalWorktreeRoot: string | undefined;

  beforeEach(() => {
    originalWorktreeRoot = process.env.PENUMBRA_WORKTREE_ROOT;
    delete process.env.PENUMBRA_WORKTREE_ROOT;
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-hooks-home-"));
  });

  afterEach(() => {
    if (originalWorktreeRoot === undefined) {
      delete process.env.PENUMBRA_WORKTREE_ROOT;
    } else {
      process.env.PENUMBRA_WORKTREE_ROOT = originalWorktreeRoot;
    }
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(repo.repoDir, { recursive: true, force: true });
    fs.rmSync(`${repo.repoDir}-worktrees`, { recursive: true, force: true });
    if (typeof repo.isolatedHome === "string") {
      fs.rmSync(repo.isolatedHome, { recursive: true, force: true });
    }
  });

  it("flags missing hooks in an isolated_install worktree when core.hooksPath is not materialized", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-missing-", { hooksPath: ".husky/_" });

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      expect(fs.existsSync(path.join(handle.path, ".husky", "pre-commit"))).toBe(true);
      expect(handle.gitHooks).toEqual({ status: "missing", configured: ".husky/_" });
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("flags the same gap in symlink_mirror mode even when the main checkout has .husky/_", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-symlink-", { hooksPath: ".husky/_" });

    fs.mkdirSync(path.join(repo.repoDir, ".husky", "_"), { recursive: true });
    fs.writeFileSync(path.join(repo.repoDir, ".husky", "_", ".gitignore"), "*");
    fs.writeFileSync(
      path.join(repo.repoDir, ".husky", "_", "pre-commit"),
      "#!/usr/bin/env sh\nexit 0\n",
    );
    fs.chmodSync(path.join(repo.repoDir, ".husky", "_", "pre-commit"), 0o755);

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    try {
      const handle = await manager.createWorktree(id);

      expect(handle.worktreeMode).toBe("symlink_mirror");
      expect(handle.gitHooks?.status).toBe("missing");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("reports not_configured when the repo sets no core.hooksPath", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-unset-", {});

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      expect(handle.gitHooks).toEqual({ status: "not_configured", configured: null });
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("flags an empty core.hooksPath as missing, because git then runs no hooks", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-empty-", { hooksPath: "" });

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      expect(handle.gitHooks).toEqual({ status: "missing", configured: "" });
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });
});
