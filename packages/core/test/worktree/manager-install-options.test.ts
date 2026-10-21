import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isPathInsideOrEqual,
  planEscapingFileDependencyLinks,
  provisionLocalCache,
  runIsolatedInstall,
  WorktreeManager,
} from "@src/worktree/manager.js";

type RunnerOptions = {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  encoding?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  stdio?: "ignore";
};
type RunnerResult = { stdout: string; stderr: string };
type RunnerCall = { cmd: string; args: string[]; opts: RunnerOptions };
type Runner = (cmd: string, args: string[], runnerOpts?: RunnerOptions) => Promise<RunnerResult>;

const calls: RunnerCall[] = [];

// async helpers from previous tests intentionally use bun:test rejects/resolves
// chain matchers. Their types are void at compile time even though they wait at
// runtime, so we avoid the chain entirely with these tiny helpers.
async function expectRejectsWith(
  promise: Promise<unknown>,
  matcher?: RegExp | string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (matcher === undefined) return;
    const message = err instanceof Error ? err.message : String(err);
    if (matcher instanceof RegExp) {
      expect(message).toMatch(matcher);
    } else {
      expect(message).toContain(matcher);
    }
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

async function expectRejectsTo<T>(promise: Promise<T>, value: unknown): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBe(value);
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

async function expectResolvesEqual<T>(promise: Promise<T>, expected: T): Promise<void> {
  const actual = await promise;
  expect(actual).toEqual(expected);
}

function copyIfExists(source: string, target: string): void {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}

function fakeGitIdentityResponse(args: string[]): RunnerResult | undefined {
  if (args[0] === "-C" && args[2] === "config" && args[3] === "user.name") {
    return { stdout: "Test User\n", stderr: "" };
  }
  if (args[0] === "-C" && args[2] === "config" && args[3] === "user.email") {
    return { stdout: "test@example.com\n", stderr: "" };
  }
  if (args[0] === "-C" && args[2] === "config" && args[3] === "extensions.worktreeConfig") {
    return { stdout: "", stderr: "" };
  }
  if (args[0] === "-C" && args[2] === "config" && args[3] === "--worktree") {
    return { stdout: "", stderr: "" };
  }
  if (args[0] === "-C" && args[2] === "log") {
    return { stdout: "Test User\0test@example.com\n", stderr: "" };
  }
  return undefined;
}

function makeRunner(opts?: { failBunInstall?: Error; timeoutBunInstall?: boolean }): Runner {
  return (cmd: string, args: string[], runnerOpts: RunnerOptions = {}): Promise<RunnerResult> => {
    calls.push({ cmd, args, opts: runnerOpts });
    if (cmd === "git" && args[0] === "show-ref" && args[1] === "--verify") {
      return Promise.reject(new Error(`missing ref ${args[2] ?? ""}`));
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      fs.mkdirSync(args[3]!, { recursive: true });
      fs.writeFileSync(path.join(args[3]!, ".git"), "gitdir: fake\n");
      copyIfExists(path.join(runnerOpts.cwd!, "package.json"), path.join(args[3]!, "package.json"));
      copyIfExists(path.join(runnerOpts.cwd!, "bun.lock"), path.join(args[3]!, "bun.lock"));
    }
    if (cmd === "git") {
      const identity = fakeGitIdentityResponse(args);
      if (identity) return Promise.resolve(identity);
    }
    if (cmd === "bun" && opts?.failBunInstall) {
      return Promise.reject(opts.failBunInstall);
    }
    if (cmd === "bun" && opts?.timeoutBunInstall) {
      const err = new Error("operation timed out") as Error & { code: string };
      err.code = "ETIMEDOUT";
      return Promise.reject(err);
    }
    return Promise.resolve({ stdout: "", stderr: "" });
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

    await expectRejectsTo(
      manager.createWorktree(handoffId, { isolated_install: true }),
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
  const observed: { rootMarker: boolean; modeMarker: string | null; readyMarker: boolean }[] = [];

  try {
    fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
    const runner: Runner = (
      cmd: string,
      args: string[],
      runnerOpts: RunnerOptions = {},
    ): Promise<RunnerResult> => {
      calls.push({ cmd, args, opts: runnerOpts });
      if (cmd === "git" && args[0] === "show-ref" && args[1] === "--verify") {
        return Promise.reject(new Error(`missing ref ${args[2] ?? ""}`));
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        fs.mkdirSync(args[3]!, { recursive: true });
        fs.writeFileSync(path.join(args[3]!, ".git"), "gitdir: fake\n");
        fs.copyFileSync(
          path.join(runnerOpts.cwd!, "package.json"),
          path.join(args[3]!, "package.json"),
        );
        fs.copyFileSync(path.join(runnerOpts.cwd!, "bun.lock"), path.join(args[3]!, "bun.lock"));
      }
      if (cmd === "git") {
        const identity = fakeGitIdentityResponse(args);
        if (identity) return Promise.resolve(identity);
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
      return Promise.resolve({ stdout: "", stderr: "" });
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
    await expectResolvesEqual(manager.discoverOrphanWorktrees(), []);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("plans links for file dependencies that escape the main repo root", () => {
  const mainRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-link-plan-main-"));
  const worktreeRoot = path.join(os.tmpdir(), "penumbra-wt-link-plan-worktree", "handoff");
  const novaContracts = path.join(path.dirname(mainRepoRoot), "nova", "packages", "contracts");

  try {
    fs.mkdirSync(novaContracts, { recursive: true });

    const manifests = [
      {
        relDir: "packages/core",
        packageJson: {
          dependencies: {
            "@nova/contracts": "file:../../../nova/packages/contracts",
            "@penumbra/in-tree": "file:../in-tree",
          },
        },
      },
    ];

    expect(planEscapingFileDependencyLinks(mainRepoRoot, worktreeRoot, manifests)).toEqual([
      {
        dependencyName: "@nova/contracts",
        linkPath: path.join(path.dirname(worktreeRoot), "nova", "packages", "contracts"),
        targetPath: novaContracts,
      },
    ]);
  } finally {
    fs.rmSync(mainRepoRoot, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(mainRepoRoot), "nova"), { recursive: true, force: true });
  }
});

test("file dependency link planning throws when an escaping target is missing", () => {
  const mainRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-link-plan-main-"));
  const worktreeRoot = path.join(os.tmpdir(), "penumbra-wt-link-plan-worktree", "handoff");

  try {
    expect(() =>
      planEscapingFileDependencyLinks(mainRepoRoot, worktreeRoot, [
        {
          relDir: "packages/core",
          packageJson: {
            dependencies: {
              "@missing/dep": "file:../../../missing/packages/dep",
            },
          },
        },
      ]),
    ).toThrow(
      new RegExp(
        [
          "@missing/dep",
          path.join(path.dirname(mainRepoRoot), "missing", "packages", "dep"),
          path.join(path.dirname(worktreeRoot), "missing", "packages", "dep"),
        ]
          .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*"),
      ),
    );
  } finally {
    fs.rmSync(mainRepoRoot, { recursive: true, force: true });
  }
});

test("path containment honors platform case sensitivity", () => {
  const parent = path.join(os.tmpdir(), "PenumbraCaseRoot");
  const child = path.join(os.tmpdir(), "penumbracaseroot", "packages", "core");
  const platformFoldsCase = process.platform === "darwin" || process.platform === "win32";

  expect(isPathInsideOrEqual(parent, child)).toBe(platformFoldsCase);
});

test("local cache provisioning copies main cache without sharing writes", () => {
  const mainRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-main-"));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-env-"));

  try {
    fs.mkdirSync(path.join(mainRepoRoot, "local_cache"), { recursive: true });
    fs.writeFileSync(path.join(mainRepoRoot, "local_cache", "seed.bin"), "seed");

    provisionLocalCache(mainRepoRoot, worktreeRoot);

    const worktreeCache = path.join(worktreeRoot, "local_cache");
    expect(fs.lstatSync(worktreeCache).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(worktreeCache, "seed.bin"), "utf8")).toBe("seed");

    fs.writeFileSync(path.join(worktreeCache, "env-only.bin"), "env");
    expect(fs.existsSync(path.join(mainRepoRoot, "local_cache", "env-only.bin"))).toBe(false);
  } finally {
    fs.rmSync(mainRepoRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("local cache provisioning rejects self-copy before removing the source", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-self-copy-"));

  try {
    fs.mkdirSync(path.join(repoRoot, "local_cache"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "local_cache", "seed.bin"), "seed");

    expect(() => {
      provisionLocalCache(repoRoot, repoRoot);
    }).toThrow("local cache source and destination resolve to the same path");
    expect(fs.readFileSync(path.join(repoRoot, "local_cache", "seed.bin"), "utf8")).toBe("seed");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("local cache provisioning rejects self-copy through a filesystem alias", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-alias-"));
  const repoRoot = path.join(fixtureRoot, "repo");
  const aliasRoot = path.join(fixtureRoot, "repo-alias");

  try {
    fs.mkdirSync(path.join(repoRoot, "local_cache"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "local_cache", "seed.bin"), "seed");
    fs.symlinkSync(repoRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

    expect(() => {
      provisionLocalCache(repoRoot, aliasRoot);
    }).toThrow("local cache source and destination resolve to the same path");
    expect(fs.readFileSync(path.join(repoRoot, "local_cache", "seed.bin"), "utf8")).toBe("seed");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local cache provisioning creates an env-local cache when main cache is absent", () => {
  const mainRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-missing-main-"));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-cache-missing-env-"));

  try {
    provisionLocalCache(mainRepoRoot, worktreeRoot);

    const worktreeCache = path.join(worktreeRoot, "local_cache");
    expect(fs.lstatSync(worktreeCache).isDirectory()).toBe(true);
    expect(fs.lstatSync(worktreeCache).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(worktreeCache, "downloaded.bin"), "env");
    expect(fs.readFileSync(path.join(worktreeCache, "downloaded.bin"), "utf8")).toBe("env");
  } finally {
    fs.rmSync(mainRepoRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("isolated install forwards abort signal and captures output", async () => {
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
    expect(bunInstall?.opts.stdio).toBeUndefined();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("default isolated install runner includes bun stderr in install failures", async () => {
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
      '#!/usr/bin/env node\nprocess.stderr.write("fixture bun failure details\\n");\nprocess.exit(1);\n',
    );
    fs.chmodSync(fakeBun, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
    });

    await expectRejectsWith(
      manager.createWorktree("h-install-output", { isolated_install: true }),
      "fixture bun failure details",
    );
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
    fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
    const manager = new WorktreeManager({
      rootDir,
      mainRepoDir: repoDir,
      runner: makeRunner({ timeoutBunInstall: true }),
    });

    await expectRejectsWith(
      manager.createWorktree("h-install-timeout", { isolated_install: true }),
      "isolated bun install timed out after 25ms",
    );
  } finally {
    if (previousTimeout === undefined) delete process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS;
    else process.env.PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS = previousTimeout;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("isolated install recognizes execFile timeout-kill error shapes", async () => {
  const timeoutErrors = [
    Object.assign(new Error("command killed"), { killed: true }),
    Object.assign(new Error("command killed"), { killed: true, signal: "SIGKILL" }),
    Object.assign(new Error("command terminated"), { signal: "SIGTERM" }),
  ];

  for (const timeoutError of timeoutErrors) {
    await expectRejectsWith(
      runIsolatedInstall(os.tmpdir(), {
        timeoutMs: 25,
        runner: () => Promise.reject(timeoutError),
      }),
      "isolated bun install timed out after 25ms",
    );
  }
});

test("isolated install reports a SIGKILL it did not send as a resource kill, not a timeout", async () => {
  for (const resourceKill of [
    Object.assign(new Error("command killed"), { killed: false, signal: "SIGKILL" }),
    Object.assign(new Error("bun exited with code 137"), { code: 137, signal: null }),
  ]) {
    const err = await runIsolatedInstall(os.tmpdir(), {
      timeoutMs: 25,
      runner: () => Promise.reject(resourceKill),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("SIGKILLed outside penumbra");
    expect((err as Error).message).not.toContain("timed out");
    expect((err as { resourceKilled?: boolean }).resourceKilled).toBe(true);
  }
});
