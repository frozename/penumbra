import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../../src/worktree/manager.js";

type RunnerOptions = {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  encoding?: string;
  signal?: AbortSignal;
  stdio?: "ignore";
};
type RunnerCall = { cmd: string; args: string[]; opts: RunnerOptions };

const calls: RunnerCall[] = [];

function makeRunner(opts?: { failBunInstall?: Error; timeoutBunInstall?: boolean }) {
  return async (cmd: string, args: string[], runnerOpts: RunnerOptions = {}) => {
    calls.push({ cmd, args, opts: runnerOpts });
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      fs.mkdirSync(args[3]!, { recursive: true });
      fs.writeFileSync(path.join(args[3]!, ".git"), "gitdir: fake\n");
    }
    if (cmd === "bun" && opts?.failBunInstall) {
      throw opts.failBunInstall;
    }
    if (cmd === "bun" && opts?.timeoutBunInstall) {
      const err = new Error("operation timed out") as Error & { code: string };
      err.code = "ETIMEDOUT";
      throw err;
    }
    return { stdout: "", stderr: "" };
  };
}

test("isolated install failure removes the partial worktree and rethrows the install error", async () => {
  calls.length = 0;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-fail-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-fail-root-"));
  const installError = new Error("install failed");
  const handoffId = "h-install-failure";

  try {
    fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      runner: makeRunner({ failBunInstall: installError }),
    });

    await expect(manager.createWorktree(handoffId, { isolated_install: true })).rejects.toBe(
      installError,
    );
    expect(fs.existsSync(path.join(rootDir, handoffId))).toBe(false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("isolated install runs bun install with timeout, maxBuffer, and script suppression", async () => {
  calls.length = 0;
  const previousTimeout = process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS;
  delete process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS;

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-opts-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-opts-root-"));

  try {
    fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      runner: makeRunner(),
    });

    await manager.createWorktree("h-install-options", { isolated_install: true });

    const bunInstall = calls.find((call) => call.cmd === "bun");
    expect(bunInstall?.args).toEqual(["install", "--ignore-scripts", "--frozen-lockfile"]);
    expect(bunInstall?.opts.timeout).toBe(120_000);
    expect(bunInstall?.opts.maxBuffer).toBe(1024 * 1024 * 10);
  } finally {
    if (previousTimeout === undefined) delete process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS;
    else process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS = previousTimeout;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("isolated install writes readiness marker only after bun install succeeds", async () => {
  calls.length = 0;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-mode-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-mode-root-"));
  const observed: Array<{ rootMarker: boolean; modeMarker: string | null; readyMarker: boolean }> =
    [];

  try {
    fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
    const runner = async (cmd: string, args: string[], runnerOpts: RunnerOptions = {}) => {
      calls.push({ cmd, args, opts: runnerOpts });
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        fs.mkdirSync(args[3]!, { recursive: true });
        fs.writeFileSync(path.join(args[3]!, ".git"), "gitdir: fake\n");
      }
      if (cmd === "bun") {
        observed.push({
          rootMarker: fs.existsSync(path.join(runnerOpts.cwd!, ".penumbra-worktree-mode")),
          modeMarker: fs.existsSync(path.join(runnerOpts.cwd!, ".test-storage", "worktree-mode"))
            ? fs.readFileSync(path.join(runnerOpts.cwd!, ".test-storage", "worktree-mode"), "utf8")
            : null,
          readyMarker: fs.existsSync(path.join(runnerOpts.cwd!, ".test-storage", "worktree-ready")),
        });
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      runner,
    });

    const handle = await manager.createWorktree("h-install-mode", { isolated_install: true });

    expect(observed).toEqual([
      { rootMarker: false, modeMarker: "isolated_install\n", readyMarker: false },
    ]);
    expect(fs.existsSync(path.join(handle.path, ".penumbra-worktree-mode"))).toBe(false);
    expect(fs.readFileSync(path.join(handle.storageRoot, "worktree-mode"), "utf8")).toBe(
      "isolated_install\n",
    );
    expect(fs.readFileSync(path.join(handle.storageRoot, "worktree-ready"), "utf8")).toBe(
      "h-install-mode\n",
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rediscovery skips isolated worktrees with a mode marker but no readiness marker", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-stale-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-stale-root-"));
  const handoffId = "12345678-1234-4234-9234-123456789abc";
  const wtPath = path.join(rootDir, handoffId);

  try {
    fs.mkdirSync(path.join(wtPath, ".test-storage"), { recursive: true });
    fs.writeFileSync(path.join(wtPath, ".git"), "gitdir: fake\n");
    fs.writeFileSync(path.join(wtPath, ".test-storage", "worktree-mode"), "isolated_install\n");

    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      runner: makeRunner(),
    });

    expect(manager.getWorktree(handoffId)).toBeNull();
    await expect(manager.discoverOrphanWorktrees()).resolves.toEqual([]);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("isolated install forwards abort signal and discards output", async () => {
  calls.length = 0;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-signal-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-signal-root-"));
  const abort = new AbortController();

  try {
    fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      runner: makeRunner(),
    });

    await manager.createWorktree("h-install-signal", {
      isolated_install: true,
      signal: abort.signal,
    });

    const bunInstall = calls.find((call) => call.cmd === "bun");
    expect(bunInstall?.opts.signal).toBe(abort.signal);
    expect(bunInstall?.opts.stdio).toBe("ignore");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("default isolated install runner does not buffer bun output", async () => {
  const previousPath = process.env.PATH;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-output-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-output-root-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-output-bin-"));

  try {
    fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    const fakeBun = path.join(binDir, "bun");
    fs.writeFileSync(
      fakeBun,
      '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(11 * 1024 * 1024));\n',
    );
    fs.chmodSync(fakeBun, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
    });

    const handle = await manager.createWorktree("h-install-output", { isolated_install: true });

    expect(handle.worktreeMode).toBe("isolated_install");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("isolated install timeout rethrows a clear timeout message", async () => {
  calls.length = 0;
  const previousTimeout = process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS;
  process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS = "25";

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-timeout-repo-"));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-timeout-root-"));

  try {
    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      runner: makeRunner({ timeoutBunInstall: true }),
    });

    await expect(
      manager.createWorktree("h-install-timeout", { isolated_install: true }),
    ).rejects.toThrow("isolated bun install timed out after 25ms");
  } finally {
    if (previousTimeout === undefined) delete process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS;
    else process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS = previousTimeout;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
