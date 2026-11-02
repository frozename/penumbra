import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "@src/logger.js";
import { detectHookInstallerArgv } from "@src/worktree/git-hooks.js";
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

async function setupHooksRepo(prefix: string, packageJson: object): Promise<HooksRepo> {
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

  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify(packageJson));

  const huskyDir = path.join(repoDir, ".husky");
  fs.mkdirSync(huskyDir, { recursive: true });
  fs.writeFileSync(path.join(huskyDir, "pre-commit"), "#!/usr/bin/env sh\nexit 1\n");
  fs.chmodSync(path.join(huskyDir, "pre-commit"), 0o755);

  await git(repoDir, ["add", "."], isolatedEnv);
  await git(repoDir, ["commit", "-m", "init"], isolatedEnv);

  await git(repoDir, ["config", "core.hooksPath", ".husky/_"], isolatedEnv);

  return { repoDir, isolatedEnv, isolatedHome };
}

interface RecordedCall {
  argv: string[];
  opts: Parameters<WorktreeCommandRunner>[2];
}

// The installer command may be wrapped by the job resource scope, so match
// on the whole argv rather than on cmd alone. The installer runs husky
// directly (`bun x husky` or node_modules/.bin/husky), never `run prepare`.
function isHuskyInstallerCall(argv: string[]): boolean {
  return argv.some((arg) => path.basename(arg) === "husky");
}

function recordingRunner(
  env: NodeJS.ProcessEnv,
  opts: { installerFails?: boolean } = {},
): { runner: WorktreeCommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: WorktreeCommandRunner = (cmd, args, callOpts) => {
    const argv = [cmd, ...args];
    calls.push({ argv, opts: callOpts });
    if (isHuskyInstallerCall(argv)) {
      if (opts.installerFails === true) {
        return Promise.reject(new Error("husky boom"));
      }
      const cwd = callOpts?.cwd;
      if (cwd === undefined) {
        return Promise.reject(new Error("hook installer invoked without cwd"));
      }
      const hooksDir = path.join(cwd, ".husky", "_");
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(hookPath, '#!/usr/bin/env sh\nexec "$(dirname "$0")/../pre-commit" "$@"\n');
      fs.chmodSync(hookPath, 0o755);
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    // A `run prepare` invocation means the manager is executing the repo's
    // prepare script verbatim — run it for real so a marker side effect
    // proves arbitrary code ran.
    if (argv.includes("run") && argv.includes("prepare")) {
      return execFile(cmd, args, {
        ...callOpts,
        env,
        encoding: callOpts?.encoding ?? "utf8",
      });
    }
    if (cmd === "bun") {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    return execFile(cmd, args, {
      ...callOpts,
      env,
      encoding: callOpts?.encoding ?? "utf8",
    });
  };
  return { runner, calls };
}

const HUSKY_PACKAGE_JSON = {
  name: "x",
  private: true,
  scripts: { prepare: "husky" },
};

describe("WorktreeManager isolated install git hooks", () => {
  let homeRoot: string;
  let repo: HooksRepo;
  let originalWorktreeRoot: string | undefined;

  beforeEach(() => {
    originalWorktreeRoot = process.env.PENUMBRA_WORKTREE_ROOT;
    delete process.env.PENUMBRA_WORKTREE_ROOT;
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-hooks-install-home-"));
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

  it("runs bare husky directly in the worktree so hooks classify as installed", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-install-", HUSKY_PACKAGE_JSON);
    const { runner, calls } = recordingRunner(repo.isolatedEnv);
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner,
    });

    const id = "11111111-1111-4111-8111-111111111111";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      expect(handle.gitHooks).toEqual({ status: "installed", configured: ".husky/_" });
      const installerCalls = calls.filter((call) => isHuskyInstallerCall(call.argv));
      expect(installerCalls.some((call) => call.opts?.cwd === handle.path)).toBe(true);
      expect(calls.some((call) => call.argv.includes("prepare"))).toBe(false);
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("passes install through to husky for the legacy husky install prepare", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-legacy-", {
      name: "x",
      private: true,
      scripts: { prepare: "husky install" },
    });
    const { runner, calls } = recordingRunner(repo.isolatedEnv);
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner,
    });

    const id = "77777777-7777-4777-8777-777777777777";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      const installerCalls = calls.filter((call) => isHuskyInstallerCall(call.argv));
      expect(installerCalls.length).toBeGreaterThan(0);
      expect(installerCalls.every((call) => call.argv.includes("install"))).toBe(true);
      expect(handle.gitHooks).toEqual({ status: "installed", configured: ".husky/_" });
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("lets the installed pre-commit hook reject a commit inside the worktree", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-commit-", HUSKY_PACKAGE_JSON);
    const { runner } = recordingRunner(repo.isolatedEnv);
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner,
    });

    const id = "22222222-2222-4222-8222-222222222222";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      fs.writeFileSync(path.join(handle.path, "hook-probe.txt"), "x\n");
      await git(handle.path, ["add", "hook-probe.txt"], repo.isolatedEnv);

      let commitError: unknown;
      try {
        await git(handle.path, ["commit", "-m", "x"], repo.isolatedEnv);
      } catch (err) {
        commitError = err;
      }
      expect(commitError).toBeDefined();
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("does not run a non-husky prepare script in the worktree", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-nonhusky-", {
      name: "x",
      private: true,
      scripts: { prepare: "tsc -b" },
    });
    const { runner, calls } = recordingRunner(repo.isolatedEnv);
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner,
    });

    const id = "33333333-3333-4333-8333-333333333333";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      expect(calls.some((call) => call.argv.includes("prepare"))).toBe(false);
      expect(handle.gitHooks?.status).toBe("missing");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("keeps the worktree when the installer fails, reporting hooks missing", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-prefail-", HUSKY_PACKAGE_JSON);
    const { runner, calls } = recordingRunner(repo.isolatedEnv, { installerFails: true });
    const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
    const log = {
      warn: (obj: unknown, msg?: unknown): void => {
        if (typeof obj === "object" && obj !== null) {
          warnings.push({
            obj: obj as Record<string, unknown>,
            msg: typeof msg === "string" ? msg : "",
          });
        }
      },
    } as unknown as Logger;
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner,
      log,
    });

    const id = "44444444-4444-4444-8444-444444444444";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      expect(fs.existsSync(handle.path)).toBe(true);
      expect(handle.gitHooks?.status).toBe("missing");
      expect(calls.some((call) => isHuskyInstallerCall(call.argv))).toBe(true);
      const installerWarning = warnings.find((entry) =>
        entry.msg.includes("hook installer failed"),
      );
      expect(installerWarning).toBeDefined();
      const err = installerWarning?.obj["err"];
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("husky boom");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("leaves hooks missing under symlink_mirror even with a husky prepare script", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-symlink-", HUSKY_PACKAGE_JSON);
    const { runner, calls } = recordingRunner(repo.isolatedEnv);
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner,
    });

    const id = "55555555-5555-4555-8555-555555555555";
    try {
      const handle = await manager.createWorktree(id);

      expect(handle.worktreeMode).toBe("symlink_mirror");
      expect(calls.some((call) => isHuskyInstallerCall(call.argv))).toBe(false);
      expect(handle.gitHooks?.status).toBe("missing");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("does not run a mixed prepare script even when it mentions husky", async () => {
    repo = await setupHooksRepo("penumbra-wt-hooks-mixed-", {
      name: "x",
      private: true,
      scripts: { prepare: "husky && echo ran > marker" },
    });
    const { runner, calls } = recordingRunner(repo.isolatedEnv);
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: repo.repoDir,
      runner,
    });

    const id = "66666666-6666-4666-8666-666666666666";
    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });

      expect(calls.some((call) => call.argv.includes("prepare"))).toBe(false);
      expect(calls.some((call) => isHuskyInstallerCall(call.argv))).toBe(false);
      expect(fs.existsSync(path.join(handle.path, "marker"))).toBe(false);
      expect(handle.gitHooks?.status).toBe("missing");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });
});

describe("detectHookInstallerArgv", () => {
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-detect-hooks-"));
  });

  afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePrepare(prepare: unknown): void {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { prepare } }),
    );
  }

  it("returns a direct husky argv for a bare husky prepare without a local bin", (): void => {
    writePrepare("husky");
    expect(detectHookInstallerArgv(dir)).toEqual(["bun", "x", "husky"]);
  });

  it("accepts the legacy husky install form and keeps install in argv", (): void => {
    writePrepare("husky install");
    expect(detectHookInstallerArgv(dir)).toEqual(["bun", "x", "husky", "install"]);
  });

  it("keeps install after the local bin for the legacy husky install form", (): void => {
    writePrepare("husky install");
    const binDir = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "husky");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    expect(detectHookInstallerArgv(dir)).toEqual([bin, "install"]);
  });

  it("prefers the resolved node_modules/.bin/husky when present", (): void => {
    writePrepare("husky");
    const binDir = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "husky");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    expect(detectHookInstallerArgv(dir)).toEqual([bin]);
  });

  it("rejects a mixed husky script so no repo code runs", (): void => {
    writePrepare("husky && echo ran > marker");
    expect(detectHookInstallerArgv(dir)).toBeNull();
    writePrepare("husky && bun run build");
    expect(detectHookInstallerArgv(dir)).toBeNull();
    writePrepare("husky || node scripts/x.js");
    expect(detectHookInstallerArgv(dir)).toBeNull();
  });

  it("rejects scripts that merely mention husky or are not husky at all", (): void => {
    writePrepare("node run-husky-thing.js");
    expect(detectHookInstallerArgv(dir)).toBeNull();
    writePrepare("echo husky");
    expect(detectHookInstallerArgv(dir)).toBeNull();
    writePrepare("tsc -b");
    expect(detectHookInstallerArgv(dir)).toBeNull();
    writePrepare(undefined);
    expect(detectHookInstallerArgv(dir)).toBeNull();
  });

  it("returns null when package.json is missing or invalid", (): void => {
    expect(detectHookInstallerArgv(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "package.json"), "{not json");
    expect(detectHookInstallerArgv(dir)).toBeNull();
  });
});
