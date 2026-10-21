import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  DISPATCH_BASE_CONFIG_KEY,
  type WorktreeCommandRunner,
  WorktreeManager,
} from "@src/worktree/manager.js";

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
    global?: { name: string; email: string };
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

  if (opts?.global) {
    fs.writeFileSync(
      path.join(isolatedHome, ".gitconfig"),
      `[user]\n\tname = ${opts.global.name}\n\temail = ${opts.global.email}\n`,
    );
  }

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

  it("records the dispatch base commit in the worktree config and keeps it after new commits", async () => {
    repo = await setupTempRepo("penumbra-wt-dispatch-base-", {
      user: { name: "Parent Author", email: "parent@example.com" },
    });

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const handoffId = "66666666-6666-4666-8666-666666666666";
    const { stdout: baseShaOut } = await git(repo.repoDir, ["rev-parse", "HEAD"], repo.isolatedEnv);
    const baseSha = baseShaOut.trim();

    const handle = await manager.createWorktree(handoffId);

    await commitInWorktree(handle.path, repo.isolatedEnv);

    const { stdout: recordedOut } = await git(
      handle.path,
      ["config", "--worktree", "--get", DISPATCH_BASE_CONFIG_KEY],
      repo.isolatedEnv,
    );
    const recorded = recordedOut.trim();
    const { stdout: headOut } = await git(handle.path, ["rev-parse", "HEAD"], repo.isolatedEnv);
    const head = headOut.trim();

    expect(recorded).toBe(baseSha);
    expect(head).not.toBe(recorded);
    expect(DISPATCH_BASE_CONFIG_KEY).toBe("penumbra.dispatchBase");

    await manager.teardownWorktree(handoffId, true);
  });

  it("does not fail createWorktree and records no base when reading the base commit fails", async () => {
    repo = await setupTempRepo("penumbra-wt-dispatch-base-read-fail-", {
      user: { name: "Parent Author", email: "parent@example.com" },
    });

    const baseRunner = isolatedRunner(repo.isolatedEnv);
    let intercepted = false;
    const failingRunner: WorktreeCommandRunner = (cmd, args, opts) => {
      if (
        !intercepted &&
        args.length === 4 &&
        args[0] === "-C" &&
        args[2] === "rev-parse" &&
        args[3] === "HEAD"
      ) {
        intercepted = true;
        return Promise.reject(new Error("rev-parse failed"));
      }
      return baseRunner(cmd, args, opts);
    };

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: failingRunner,
    });

    const handle = await manager.createWorktree("77777777-7777-4777-8777-777777777777");

    await expect(
      git(
        handle.path,
        ["config", "--worktree", "--get", DISPATCH_BASE_CONFIG_KEY],
        repo.isolatedEnv,
      ),
    ).rejects.toThrow();

    await manager.teardownWorktree("77777777-7777-4777-8777-777777777777", true);
  });

  it("records no base when the base commit is not a SHA", async () => {
    repo = await setupTempRepo("penumbra-wt-dispatch-base-not-sha-", {
      user: { name: "Parent Author", email: "parent@example.com" },
    });

    const baseRunner = isolatedRunner(repo.isolatedEnv);
    let intercepted = false;
    const badOutputRunner: WorktreeCommandRunner = (cmd, args, opts) => {
      if (
        !intercepted &&
        args.length === 4 &&
        args[0] === "-C" &&
        args[2] === "rev-parse" &&
        args[3] === "HEAD"
      ) {
        intercepted = true;
        return Promise.resolve({ stdout: "not-a-sha\n", stderr: "" });
      }
      return baseRunner(cmd, args, opts);
    };

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: badOutputRunner,
    });

    const handle = await manager.createWorktree("88888888-8888-4888-8888-888888888888");

    await expect(
      git(
        handle.path,
        ["config", "--worktree", "--get", DISPATCH_BASE_CONFIG_KEY],
        repo.isolatedEnv,
      ),
    ).rejects.toThrow();

    await manager.teardownWorktree("88888888-8888-4888-8888-888888888888", true);
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

  it("prefers the effective parent config (including global) over the base ref commit author", async () => {
    repo = await setupTempRepo("penumbra-wt-identity-global-", {
      global: { name: "Global Author", email: "global@example.com" },
      commitAuthor: { name: "Base Commit Author", email: "basecommit@example.com" },
    });

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: isolatedRunner(repo.isolatedEnv),
    });

    const handle = await manager.createWorktree("44444444-4444-4444-8444-444444444444");

    const { stdout: name } = await git(handle.path, ["config", "user.name"], repo.isolatedEnv);
    const { stdout: email } = await git(handle.path, ["config", "user.email"], repo.isolatedEnv);

    expect(name.trim()).toBe("Global Author");
    expect(email.trim()).toBe("global@example.com");

    await commitInWorktree(handle.path, repo.isolatedEnv);

    const { stdout: logAuthor } = await git(
      handle.path,
      ["log", "-1", "--format=%an <%ae>"],
      repo.isolatedEnv,
    );
    expect(logAuthor.trim()).toBe("Global Author <global@example.com>");

    const { stdout: baseAuthor } = await git(
      repo.repoDir,
      ["log", "-1", "--format=%an <%ae>", "HEAD"],
      repo.isolatedEnv,
    );
    expect(baseAuthor.trim()).toBe("Base Commit Author <basecommit@example.com>");

    await manager.teardownWorktree("44444444-4444-4444-8444-444444444444", true);
  });

  it("does not re-enable extensions.worktreeConfig when it is already set", async () => {
    repo = await setupTempRepo("penumbra-wt-identity-wtconfig-idempotent-", {
      user: { name: "Local Author", email: "local@example.com" },
    });

    await git(repo.repoDir, ["config", "extensions.worktreeConfig", "true"], repo.isolatedEnv);

    const calls: string[][] = [];
    const recordingRunner: WorktreeCommandRunner = (cmd, args, opts) => {
      calls.push(args);
      return execFile(cmd, args, {
        ...opts,
        env: { ...process.env, ...repo.isolatedEnv },
        encoding: opts?.encoding ?? "utf8",
      });
    };

    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner: recordingRunner,
    });

    const handle = await manager.createWorktree("55555555-5555-4555-8555-555555555555");

    const setWorktreeConfig = calls.filter(
      (args) =>
        args[0] === "-C" &&
        args[1] === repo.repoDir &&
        args[2] === "config" &&
        args[3] === "extensions.worktreeConfig" &&
        args[4] === "true",
    );
    expect(setWorktreeConfig).toEqual([]);

    const getWorktreeConfig = calls.filter(
      (args) =>
        args[0] === "-C" &&
        args[1] === repo.repoDir &&
        args[2] === "config" &&
        args[3] === "--get" &&
        args[4] === "--local" &&
        args[5] === "extensions.worktreeConfig",
    );
    expect(getWorktreeConfig.length).toBe(1);

    const { stdout: name } = await git(handle.path, ["config", "user.name"], repo.isolatedEnv);
    const { stdout: email } = await git(handle.path, ["config", "user.email"], repo.isolatedEnv);
    expect(name.trim()).toBe("Local Author");
    expect(email.trim()).toBe("local@example.com");

    await manager.teardownWorktree("55555555-5555-4555-8555-555555555555", true);
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
