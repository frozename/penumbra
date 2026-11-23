import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ISOLATED_INSTALL_ARGS,
  ISOLATED_INSTALL_CACHE_KEY,
  resolveIsolatedInstallCommand,
} from "@src/worktree/install-command.js";
import { runIsolatedInstall, WorktreeManager } from "@src/worktree/manager.js";

type RunnerOptions = { cwd?: string; env?: NodeJS.ProcessEnv };
type RunnerResult = { stdout: string; stderr: string };
type RunnerCall = { cmd: string; args: string[]; opts: RunnerOptions };
type Runner = (cmd: string, args: string[], runnerOpts?: RunnerOptions) => Promise<RunnerResult>;

const BUN_COMMAND = "bun install --ignore-scripts --frozen-lockfile";
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

let tmp = "";
let repoDir = "";
let rootDir = "";
let binDir = "";
let calls: RunnerCall[] = [];
let previousPath: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-install-pm-"));
  repoDir = path.join(tmp, "repo");
  rootDir = path.join(tmp, "worktrees");
  binDir = path.join(tmp, "bin");
  fs.mkdirSync(repoDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(repoDir, "package.json"), "{}\n");
  calls = [];
  previousPath = process.env.PATH;
});

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function putOnPath(...binaries: string[]): void {
  for (const binary of binaries) {
    fs.writeFileSync(path.join(binDir, binary), "#!/bin/sh\n", { mode: 0o755 });
  }
  process.env.PATH = binDir;
}

function seedLockfiles(...names: string[]): void {
  for (const name of names) fs.writeFileSync(path.join(repoDir, name), "");
}

function fakeWorktreeAdd(wtPath: string, repoRoot: string): void {
  fs.mkdirSync(wtPath, { recursive: true });
  fs.writeFileSync(path.join(wtPath, ".git"), "gitdir: fake\n");
  for (const name of ["package.json", ...LOCKFILES]) {
    const source = path.join(repoRoot, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(wtPath, name));
  }
}

const GIT_IDENTITY_OUTPUT: Record<string, string> = {
  "config user.name": "Test User\n",
  "config user.email": "test@example.com\n",
  log: "Test User\0test@example.com\n",
};

function fakeGit(args: string[], cwd: string | undefined): RunnerResult | Error {
  if (args[0] === "show-ref") return new Error(`missing ref ${args[2] ?? ""}`);
  if (args[0] === "worktree" && args[1] === "add") fakeWorktreeAdd(args[3] ?? "", cwd ?? "");
  if (args[0] !== "-C") return { stdout: "", stderr: "" };
  const identityKey = args[2] === "log" ? "log" : args.slice(2, 4).join(" ");
  return { stdout: GIT_IDENTITY_OUTPUT[identityKey] ?? "", stderr: "" };
}

const runner: Runner = (cmd, args, runnerOpts = {}) => {
  calls.push({ cmd, args, opts: runnerOpts });
  if (cmd !== "git") return Promise.resolve({ stdout: "", stderr: "" });
  const result = fakeGit(args, runnerOpts.cwd);
  return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
};

function installCalls(): string[] {
  return calls.filter((call) => call.cmd !== "git").map((c) => [c.cmd, ...c.args].join(" "));
}

function makeManager(packageManagers: Record<string, "bun" | "npm"> = {}): WorktreeManager {
  return new WorktreeManager({
    rootDir,
    mainRepoDir: repoDir,
    runner,
    resolveProjectRoot: () => repoDir,
    resolvePackageManager: (projectId) => packageManagers[projectId],
  });
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected promise to reject but it resolved");
}

test("the bun install command and its cache key are unchanged", () => {
  expect([...ISOLATED_INSTALL_ARGS]).toEqual(["install", "--ignore-scripts", "--frozen-lockfile"]);
  expect(ISOLATED_INSTALL_CACHE_KEY).toBe(BUN_COMMAND);
});

test("a bun-lockfile project gets today's bun command byte for byte", async () => {
  for (const lockfile of ["bun.lock", "bun.lockb"]) {
    calls = [];
    fs.rmSync(path.join(repoDir, "bun.lock"), { force: true });
    seedLockfiles(lockfile);
    // No npm, node or bun on PATH: the bun path must not start checking PATH.
    process.env.PATH = binDir;

    await makeManager().createWorktree(`h-bun-${lockfile}`, { isolated_install: true });

    expect(installCalls()).toEqual([BUN_COMMAND]);
  }
});

test("a project with no lockfile keeps today's bun command", async () => {
  await makeManager().createWorktree("h-no-lockfile", { isolated_install: true });

  expect(installCalls()).toEqual([BUN_COMMAND]);
});

test("bun wins when a bun lockfile sits beside a package-lock.json", async () => {
  seedLockfiles("bun.lock", "package-lock.json");

  await makeManager().createWorktree("h-both", { isolated_install: true });

  expect(installCalls()).toEqual([BUN_COMMAND]);
});

test("an npm-lockfile project is installed with npm ci and no lifecycle scripts", async () => {
  seedLockfiles("package-lock.json");
  putOnPath("npm", "node");

  const handle = await makeManager().createWorktree("h-npm", { isolated_install: true });

  expect(installCalls()).toEqual(["npm ci --ignore-scripts"]);
  const install = calls.find((call) => call.cmd === "npm");
  expect(install?.opts.cwd).toBe(handle.path);
  expect(handle.worktreeMode).toBe("isolated_install");
  expect(fs.readFileSync(path.join(handle.path, ".test-storage/worktree-ready"), "utf8")).toBe(
    "h-npm\n",
  );
});

test("the project registry's package_manager overrides lockfile detection", async () => {
  seedLockfiles("bun.lock", "package-lock.json");
  putOnPath("npm", "node");

  await makeManager({ "npm-proj": "npm" }).createWorktree("h-override-npm", {
    isolated_install: true,
    project_id: "npm-proj",
  });
  await makeManager({ "bun-proj": "bun" }).createWorktree("h-override-bun", {
    isolated_install: true,
    project_id: "bun-proj",
  });
  await makeManager({ "npm-proj": "npm" }).createWorktree("h-other-project", {
    isolated_install: true,
    project_id: "unlisted",
  });

  expect(installCalls()).toEqual(["npm ci --ignore-scripts", BUN_COMMAND, BUN_COMMAND]);
});

test("a declared package manager installs a project whose lockfile is unsupported", async () => {
  seedLockfiles("yarn.lock");
  putOnPath("npm", "node");

  await makeManager({ proj: "npm" }).createWorktree("h-declared", {
    isolated_install: true,
    project_id: "proj",
  });

  expect(installCalls()).toEqual(["npm ci --ignore-scripts"]);
});

test("pnpm and yarn lockfiles fail with an error naming the unsupported manager", async () => {
  for (const [lockfile, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ] as const) {
    calls = [];
    fs.rmSync(path.join(repoDir, "pnpm-lock.yaml"), { force: true });
    seedLockfiles(lockfile);
    const handoffId = `h-${manager}`;

    const message = await rejectionMessage(
      makeManager().createWorktree(handoffId, { isolated_install: true }),
    );

    expect(message).toContain(`${manager} is not a supported package manager`);
    expect(message).toContain(lockfile);
    expect(message).toContain("package_manager");
    expect(installCalls()).toEqual([]);
    expect(fs.existsSync(path.join(rootDir, handoffId))).toBe(false);
  }
});

test("a symlink-mirror worktree never resolves an install command", async () => {
  seedLockfiles("yarn.lock");

  const handle = await makeManager().createWorktree("h-mirror", { isolated_install: false });

  expect(handle.worktreeMode).toBe("symlink_mirror");
  expect(installCalls()).toEqual([]);
});

test("npm missing from PATH fails before the install with the exact binary and PATH", async () => {
  seedLockfiles("package-lock.json");
  putOnPath("node");

  const message = await rejectionMessage(
    makeManager().createWorktree("h-no-npm", { isolated_install: true }),
  );

  expect(message).toContain("isolated npm install cannot run: npm is not on PATH");
  expect(message).toContain(`PATH=${binDir}`);
  expect(message).toContain("package-lock.json");
  expect(installCalls()).toEqual([]);
  expect(fs.existsSync(path.join(rootDir, "h-no-npm"))).toBe(false);
});

test("node missing from PATH is named too, because npm cannot start without it", async () => {
  const env = { PATH: binDir };
  fs.writeFileSync(path.join(binDir, "npm"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(repoDir, "package-lock.json"), "");

  const message = await rejectionMessage(runIsolatedInstall(repoDir, { runner, env }));

  expect(message).toContain("isolated npm install cannot run: node is not on PATH");
  expect(installCalls()).toEqual([]);
});

test("a non-executable npm file on PATH does not count as npm", async () => {
  const env = { PATH: binDir };
  fs.writeFileSync(path.join(binDir, "npm"), "", { mode: 0o644 });
  fs.writeFileSync(path.join(binDir, "node"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(repoDir, "package-lock.json"), "");

  const message = await rejectionMessage(runIsolatedInstall(repoDir, { runner, env }));

  expect(message).toContain("npm is not on PATH");
});

test("npm install failures are labelled npm and keep the stderr tail", async () => {
  putOnPath("npm", "node");
  seedLockfiles("package-lock.json");
  const failing: Runner = () =>
    Promise.reject(Object.assign(new Error("exit 1"), { code: 1, stderr: "npm error EUSAGE\n" }));

  const message = await rejectionMessage(runIsolatedInstall(repoDir, { runner: failing }));

  expect(message).toBe("isolated npm install failed: npm error EUSAGE");
});

test("npm install timeouts are labelled npm", async () => {
  putOnPath("npm", "node");
  seedLockfiles("package-lock.json");
  const timingOut: Runner = () =>
    Promise.reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));

  const message = await rejectionMessage(
    runIsolatedInstall(repoDir, { runner: timingOut, timeoutMs: 5 }),
  );

  expect(message).toBe("isolated npm install timed out after 5ms");
});

test("the install cache key follows the resolved command", () => {
  seedLockfiles("package-lock.json");
  expect(resolveIsolatedInstallCommand(repoDir).cacheKey).toBe("npm ci --ignore-scripts");
  expect(resolveIsolatedInstallCommand(repoDir, "bun").cacheKey).toBe(ISOLATED_INSTALL_CACHE_KEY);

  seedLockfiles("bun.lock");
  expect(resolveIsolatedInstallCommand(repoDir).cacheKey).toBe(ISOLATED_INSTALL_CACHE_KEY);
  expect(resolveIsolatedInstallCommand(repoDir).argv).toEqual(["bun", ...ISOLATED_INSTALL_ARGS]);
});
