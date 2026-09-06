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

async function setupTempRepo(
  prefix: string,
  opts?: {
    user?: { name: string; email: string };
    commitAuthor?: { name: string; email: string };
  },
): Promise<{ repoDir: string; isolatedEnv: NodeJS.ProcessEnv }> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  const isolatedEnv = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
  };

  await git(repoDir, ["init", "-b", "main"], isolatedEnv);

  const commitArgs: string[] = [];
  if (opts?.user) {
    await git(repoDir, ["config", "user.name", opts.user.name], isolatedEnv);
    await git(repoDir, ["config", "user.email", opts.user.email], isolatedEnv);
  }
  if (opts?.commitAuthor) {
    commitArgs.push("-c", `user.name=${opts.commitAuthor.name}`);
    commitArgs.push("-c", `user.email=${opts.commitAuthor.email}`);
  }

  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  await git(repoDir, ["add", "."], isolatedEnv);
  await git(repoDir, [...commitArgs, "commit", "-m", "init"], isolatedEnv);

  return { repoDir, isolatedEnv };
}

function isolatedRunner(env: NodeJS.ProcessEnv): WorktreeCommandRunner {
  return (cmd, args, opts) =>
    execFile(cmd, args, {
      ...opts,
      env: { ...process.env, ...env },
      encoding: opts?.encoding ?? "utf8",
    });
}

describe("WorktreeManager.createWorktree — git identity inheritance", () => {
  let homeRoot: string;
  let repo: { repoDir: string; isolatedEnv: NodeJS.ProcessEnv };
  let originalWorktreeRoot: string | undefined;

  beforeEach(() => {
    originalWorktreeRoot = process.env.PENUMBRA_WORKTREE_ROOT;
    delete process.env.PENUMBRA_WORKTREE_ROOT;
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-identity-home-"));
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
    const isolatedHome = repo.isolatedEnv.HOME;
    if (typeof isolatedHome === "string") {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  async function commitInWorktree(wtPath: string, env: NodeJS.ProcessEnv): Promise<void> {
    fs.writeFileSync(path.join(wtPath, "identity-check.txt"), "ok\n");
    await git(wtPath, ["add", "identity-check.txt"], env);
    await git(wtPath, ["commit", "-m", "identity check"], env);
  }

  it("inherits user.name and user.email from the parent repo's git config", async () => {
    repo = await setupTempRepo("penumbra-wt-identity-cfg-", {
      user: { name: "Parent Author", email: "parent@example.com" },
    });

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const handle = await manager.createWorktree("11111111-1111-4111-8111-111111111111");

    const { stdout: name } = await git(handle.path, ["config", "user.name"], repo.isolatedEnv);
    const { stdout: email } = await git(handle.path, ["config", "user.email"], repo.isolatedEnv);

    expect(name.trim()).toBe("Parent Author");
    expect(email.trim()).toBe("parent@example.com");

    await commitInWorktree(handle.path, repo.isolatedEnv);

    const { stdout: logAuthor } = await git(
      handle.path,
      ["log", "-1", "--format=%an <%ae>"],
      repo.isolatedEnv,
    );
    expect(logAuthor.trim()).toBe("Parent Author <parent@example.com>");

    await manager.teardownWorktree("11111111-1111-4111-8111-111111111111", true);
  });

  it("falls back to the base ref commit author when the parent git config is absent", async () => {
    repo = await setupTempRepo("penumbra-wt-identity-commit-", {
      commitAuthor: { name: "Commit Author", email: "commit@example.com" },
    });

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const handle = await manager.createWorktree("22222222-2222-4222-8222-222222222222");

    const { stdout: name } = await git(handle.path, ["config", "user.name"], repo.isolatedEnv);
    const { stdout: email } = await git(handle.path, ["config", "user.email"], repo.isolatedEnv);

    expect(name.trim()).toBe("Commit Author");
    expect(email.trim()).toBe("commit@example.com");

    await commitInWorktree(handle.path, repo.isolatedEnv);

    const { stdout: logAuthor } = await git(
      handle.path,
      ["log", "-1", "--format=%an <%ae>"],
      repo.isolatedEnv,
    );
    expect(logAuthor.trim()).toBe("Commit Author <commit@example.com>");

    await manager.teardownWorktree("22222222-2222-4222-8222-222222222222", true);
  });

  it("refuses to provision when the parent repository has no usable identity", async () => {
    repo = await setupTempRepo("penumbra-wt-identity-missing-", {
      commitAuthor: { name: "Bad", email: "not-an-email" },
    });

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    try {
      await manager.createWorktree("33333333-3333-4333-8333-333333333333");
      throw new Error("expected createWorktree to reject");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/worktree_parent_identity/);
    }

    expect(fs.existsSync(path.join(homeRoot, "33333333-3333-4333-8333-333333333333"))).toBe(false);
  });
});
