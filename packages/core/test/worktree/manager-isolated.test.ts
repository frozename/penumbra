import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { exec as execCb, execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  isPathInsideOrEqual,
  materializeWorkspaceLinks,
  type WorktreeCommandRunner,
  WorktreeManager,
} from "@src/worktree/manager.js";

const TEST_TMP_ROOT = fs.realpathSync.native(os.tmpdir());

// node:util.promisify(child_process.exec)'s declaration overloads make TS pick
// the void-returning variant in eslint's type-aware pass; the runtime is in
// fact a Promise (per util.promisify.custom), so the explicit shape closes the
// gap without an `as any` dodge.
type ExecResult = { stdout: string; stderr: string };
type ExecOpts = { cwd?: string; env?: NodeJS.ProcessEnv };
const exec: (command: string, opts?: ExecOpts) => Promise<ExecResult> = promisify(execCb);
const execFile: (file: string, args?: string[], opts?: ExecOpts) => Promise<ExecResult> =
  promisify(execFileCb);
const TSC_BIN = path.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const originalBunTmpDir = process.env.BUN_TMPDIR;
const originalBunInstall = process.env.BUN_INSTALL;
const originalHome = process.env.HOME;
const originalTmpDir = process.env.TMPDIR;
const sharedBunTmpDir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "penumbra-wt-bun-tmp-"));
process.env.BUN_TMPDIR = sharedBunTmpDir;
process.env.BUN_INSTALL = sharedBunTmpDir;
process.env.HOME = sharedBunTmpDir;
process.env.TMPDIR = sharedBunTmpDir;

function withBunEnv(opts: ExecOpts): ExecOpts {
  return {
    ...opts,
    env: {
      ...process.env,
      BUN_INSTALL: sharedBunTmpDir,
      BUN_TMPDIR: sharedBunTmpDir,
      HOME: sharedBunTmpDir,
      TMPDIR: sharedBunTmpDir,
    },
  };
}

async function bunInstall(cwd: string): Promise<void> {
  await execFile("bun", ["install"], withBunEnv({ cwd }));
}

function createWorkspaceNodeModules(repoDir: string): void {
  const daemonScopeDir = path.join(repoDir, "packages", "daemon", "node_modules", "@penumbra");
  fs.mkdirSync(daemonScopeDir, { recursive: true });
  fs.symlinkSync(path.join(repoDir, "packages", "core"), path.join(daemonScopeDir, "core"), "dir");
  fs.mkdirSync(path.join(repoDir, "node_modules"), { recursive: true });
}

const workspaceInstallRunner: WorktreeCommandRunner = async (cmd, args, opts = {}) => {
  if (cmd === "bun") {
    createWorkspaceNodeModules(opts.cwd!);
    return { stdout: "", stderr: "" };
  }
  return await execFile(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    signal: opts.signal,
  });
};

async function setupWorkspaceRepo(prefix: string): Promise<string> {
  const repoDir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, prefix));
  await exec("git init -b main", { cwd: repoDir });
  await exec('git config user.email "test@example.com"', { cwd: repoDir });
  await exec('git config user.name "test"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "test-root",
        type: "module",
        workspaces: ["packages/*", "packages/integrations/*"],
        devDependencies: {
          "@penumbra/core": "workspace:*",
          "@penumbra/sirius-middleware": "workspace:*",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(repoDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["packages/**/*.ts"],
      },
      null,
      2,
    ),
  );

  const coreDir = path.join(repoDir, "packages", "core");
  fs.mkdirSync(coreDir, { recursive: true });
  fs.writeFileSync(
    path.join(coreDir, "package.json"),
    JSON.stringify(
      {
        name: "@penumbra/core",
        version: "0.0.1",
        exports: { ".": "./index.ts" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(coreDir, "index.ts"), "export const existingValue = 1;\n");

  const daemonDir = path.join(repoDir, "packages", "daemon");
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(
    path.join(daemonDir, "package.json"),
    JSON.stringify(
      {
        name: "@penumbra/daemon",
        version: "0.0.1",
        dependencies: { "@penumbra/core": "workspace:*" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(daemonDir, "index.ts"),
    'import { existingValue } from "@penumbra/core";\nconsole.log(existingValue);\n',
  );

  const agentchatDir = path.join(repoDir, "packages", "agentchat");
  fs.mkdirSync(agentchatDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentchatDir, "package.json"),
    JSON.stringify(
      {
        name: "@penumbra/agentchat",
        version: "0.0.1",
        dependencies: { "@penumbra/core": "workspace:*" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(agentchatDir, "index.ts"),
    'import { existingValue } from "@penumbra/core";\nconsole.log(existingValue);\n',
  );

  const siriusDir = path.join(repoDir, "packages", "integrations", "sirius-middleware");
  fs.mkdirSync(siriusDir, { recursive: true });
  fs.writeFileSync(
    path.join(siriusDir, "package.json"),
    JSON.stringify(
      {
        name: "@penumbra/sirius-middleware",
        version: "0.0.1",
        exports: { ".": "./index.ts" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(siriusDir, "index.ts"), "export const middleware = true;\n");

  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  await exec("git add . && git commit -m init", { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "bun.lock"), "");
  createWorkspaceNodeModules(repoDir);
  return repoDir;
}

async function setupRepoWithExternalFileDependency(): Promise<{
  repoDir: string;
  externalPackageDir: string;
}> {
  const repoDir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "penumbra-wt-filedep-repo-"));
  const externalPackageDir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "penumbra-wt-filedep-ext-"));
  await exec("git init -b main", { cwd: repoDir });
  await exec('git config user.email "test@example.com"', { cwd: repoDir });
  await exec('git config user.name "test"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(externalPackageDir, "package.json"),
    JSON.stringify({ name: "@fixture/external", version: "1.0.0", main: "index.js" }, null, 2),
  );
  fs.writeFileSync(path.join(externalPackageDir, "index.js"), "export const value = 1;\n");

  const fileSpecifier = `file:${path.relative(repoDir, externalPackageDir)}`;
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "filedep-root",
        type: "module",
        dependencies: { "@fixture/external": fileSpecifier },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(repoDir, "README.md"), "# filedep\n");
  await bunInstall(repoDir);
  await exec("git add package.json bun.lock README.md", { cwd: repoDir });
  await exec('git commit -m "init"', { cwd: repoDir });

  return { repoDir, externalPackageDir };
}

async function runTypecheck(cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await exec(`node "${TSC_BIN}" --noEmit -p tsconfig.json`, { cwd });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    const typed = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${typed.stdout ?? ""}${typed.stderr ?? ""}${typed.message ?? ""}`,
    };
  }
}

function resolveWorkspaceLink(wtRoot: string, pkgName: string): string {
  const linkPath = path.join(wtRoot, "packages", "daemon", "node_modules", ...pkgName.split("/"));
  if (!fs.existsSync(linkPath)) {
    throw new Error(`Expected workspace link does not exist: ${linkPath}`);
  }
  return fs.realpathSync.native(linkPath);
}

function rootWorkspaceLinkPath(wtRoot: string, pkgName: string): string {
  return path.join(wtRoot, "node_modules", ...pkgName.split("/"));
}

function expectRootWorkspaceLinkInsideWorktree(wtRoot: string, pkgName: string): fs.Stats {
  return expectRootWorkspaceLinkTarget(
    wtRoot,
    pkgName,
    path.join("packages", pkgName.replace(/^@penumbra\//, "")),
  );
}

function expectRootWorkspaceLinkTarget(
  wtRoot: string,
  pkgName: string,
  packageRelDir: string,
): fs.Stats {
  const linkPath = rootWorkspaceLinkPath(wtRoot, pkgName);
  expect(fs.existsSync(linkPath)).toBe(true);
  const stat = fs.lstatSync(linkPath);
  expect(stat.isSymbolicLink()).toBe(true);

  const packageDir = path.join(wtRoot, packageRelDir);
  expect(fs.realpathSync.native(linkPath)).toBe(fs.realpathSync.native(packageDir));
  expect(isPathInsideOrEqual(wtRoot, fs.realpathSync.native(linkPath))).toBe(true);
  return stat;
}

describe("WorktreeManager isolated-install mode", () => {
  let homeRoot = "";
  let homeRepo = "";
  let counter = 0;

  afterAll(() => {
    if (originalBunTmpDir === undefined) delete process.env.BUN_TMPDIR;
    else process.env.BUN_TMPDIR = originalBunTmpDir;
    if (originalBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = originalBunInstall;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    fs.rmSync(sharedBunTmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    homeRoot = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "penumbra-wt-isolated-"));
    homeRepo = await setupWorkspaceRepo("penumbra-wt-repo-");
  });

  afterEach(() => {
    if (homeRoot) fs.rmSync(homeRoot, { recursive: true, force: true });
    if (homeRepo) {
      fs.rmSync(homeRepo, { recursive: true, force: true });
      fs.rmSync(`${homeRepo}-worktrees`, { recursive: true, force: true });
    }
  });

  function nextHandoff(): string {
    return `wt-isolated-${String(Date.now())}-${String(++counter)}`;
  }

  it("default mode mirrors node_modules symlinks to main repo and keeps the stale-type trap", async () => {
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner: workspaceInstallRunner,
    });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id);

    try {
      const topNm = path.join(handle.path, "node_modules");
      expect(fs.lstatSync(topNm).isSymbolicLink()).toBe(true);

      const mainRepoCore = fs.realpathSync.native(path.join(homeRepo, "packages", "core"));
      expect(resolveWorkspaceLink(handle.path, "@penumbra/core")).toBe(mainRepoCore);

      fs.writeFileSync(
        path.join(handle.path, "packages", "core", "index.ts"),
        "export const existingValue = 1;\nexport interface SharedShape { added: string }\n",
      );
      fs.writeFileSync(
        path.join(handle.path, "packages", "daemon", "index.ts"),
        'import type { SharedShape } from "@penumbra/core";\nconst value: SharedShape = { added: "yes" };\nconsole.log(value);\n',
      );

      const result = await runTypecheck(handle.path);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("SharedShape");
      expect(handle.worktreeMode).toBe("symlink_mirror");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("isolated mode runs bun install in worktree and creates workspace-local links", async () => {
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner: workspaceInstallRunner,
    });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id, { isolated_install: true });

    try {
      const topNm = path.join(handle.path, "node_modules");
      expect(fs.existsSync(topNm)).toBe(true);
      expect(fs.lstatSync(topNm).isSymbolicLink()).toBe(false);

      const wtCore = fs.realpathSync.native(path.join(handle.path, "packages", "core"));
      expect(resolveWorkspaceLink(handle.path, "@penumbra/core")).toBe(wtCore);

      fs.writeFileSync(
        path.join(handle.path, "packages", "core", "index.ts"),
        "export const existingValue = 1;\nexport interface SharedShape { added: string }\n",
      );
      fs.writeFileSync(
        path.join(handle.path, "packages", "daemon", "index.ts"),
        'import type { SharedShape } from "@penumbra/core";\nconst value: SharedShape = { added: "yes" };\nconsole.log(value);\n',
      );

      const result = await runTypecheck(handle.path);
      expect(result.output).toBe("");
      expect(result.ok).toBe(true);
      expect(handle.worktreeMode).toBe("isolated_install");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("isolated install materializes only root-declared worktree-local @penumbra links", async () => {
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner: workspaceInstallRunner,
    });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id, { isolated_install: true });

    try {
      expectRootWorkspaceLinkInsideWorktree(handle.path, "@penumbra/core");
      expect(fs.readdirSync(path.join(handle.path, "node_modules", "@penumbra")).sort()).toEqual([
        "core",
        "sirius-middleware",
      ]);
      expect(fs.existsSync(rootWorkspaceLinkPath(handle.path, "@penumbra/daemon"))).toBe(false);
      expect(fs.existsSync(rootWorkspaceLinkPath(handle.path, "@penumbra/agentchat"))).toBe(false);

      const requireFromAgentchat = createRequire(
        path.join(handle.path, "packages", "agentchat", "index.ts"),
      );
      expect(() => requireFromAgentchat.resolve("@penumbra/daemon")).toThrow();
      expect(fs.realpathSync.native(requireFromAgentchat.resolve("@penumbra/core"))).toBe(
        fs.realpathSync.native(path.join(handle.path, "packages", "core", "index.ts")),
      );
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("isolated install replaces existing @penumbra links that escape the worktree", async () => {
    const escapingRunner: WorktreeCommandRunner = async (cmd, args, opts = {}) => {
      const result = await workspaceInstallRunner(cmd, args, opts);
      if (cmd === "bun") {
        const scopeDir = path.join(opts.cwd!, "node_modules", "@penumbra");
        fs.mkdirSync(scopeDir, { recursive: true });
        fs.symlinkSync(path.join(homeRepo, "packages", "core"), path.join(scopeDir, "core"), "dir");
      }
      return result;
    };
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner: escapingRunner,
    });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id, { isolated_install: true });

    try {
      expectRootWorkspaceLinkInsideWorktree(handle.path, "@penumbra/core");
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("isolated install leaves correct existing @penumbra links untouched", async () => {
    let beforeStat: fs.Stats | undefined;
    const preservingRunner: WorktreeCommandRunner = async (cmd, args, opts = {}) => {
      const result = await workspaceInstallRunner(cmd, args, opts);
      if (cmd === "bun") {
        const linkPath = rootWorkspaceLinkPath(opts.cwd!, "@penumbra/core");
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync("../../packages/core", linkPath, "dir");
        beforeStat = fs.lstatSync(linkPath);
      }
      return result;
    };
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner: preservingRunner,
    });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id, { isolated_install: true });

    try {
      const afterStat = expectRootWorkspaceLinkInsideWorktree(handle.path, "@penumbra/core");
      expect(beforeStat).toBeDefined();
      expect(afterStat.ino).toBe(beforeStat!.ino);
      expect(afterStat.mtimeMs).toBe(beforeStat!.mtimeMs);
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("workspace link materialization refuses to replace non-symlink package entries", () => {
    const linkPath = rootWorkspaceLinkPath(homeRepo, "@penumbra/core");
    const sentinelPath = path.join(linkPath, "sentinel.txt");
    fs.mkdirSync(linkPath, { recursive: true });
    fs.writeFileSync(sentinelPath, "operator-owned content\n");

    expect(() => {
      materializeWorkspaceLinks(homeRepo);
    }).toThrow(/refusing to replace non-symlink isolated install workspace link/);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("operator-owned content\n");
    expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
  });

  it("workspace link materialization replaces dangling package symlinks", () => {
    const linkPath = rootWorkspaceLinkPath(homeRepo, "@penumbra/core");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync("../../missing-core", linkPath, "dir");

    materializeWorkspaceLinks(homeRepo);

    expectRootWorkspaceLinkInsideWorktree(homeRepo, "@penumbra/core");
  });

  it("workspace link materialization follows nested workspace package globs", () => {
    materializeWorkspaceLinks(homeRepo);

    expectRootWorkspaceLinkTarget(
      homeRepo,
      "@penumbra/sirius-middleware",
      path.join("packages", "integrations", "sirius-middleware"),
    );
  });

  it("isolated install fails closed when @penumbra link materialization fails", async () => {
    const failingRunner: WorktreeCommandRunner = async (cmd, args, opts = {}) => {
      if (cmd === "bun") {
        fs.writeFileSync(path.join(opts.cwd!, "node_modules"), "not a directory\n");
        return { stdout: "", stderr: "" };
      }
      return await workspaceInstallRunner(cmd, args, opts);
    };
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner: failingRunner,
    });
    const id = nextHandoff();

    let createErr: unknown;
    try {
      await manager.createWorktree(id, { isolated_install: true });
    } catch (err) {
      createErr = err;
    }

    expect(createErr).toBeDefined();
    expect(manager.getWorktree(id)).toBeNull();
    expect(fs.existsSync(path.join(homeRoot, id))).toBe(false);
  });

  it("rediscovery preserves isolated worktree topology instead of remirroring node_modules", async () => {
    const manager = new WorktreeManager({
      rootDir: homeRoot,
      mainRepoDir: homeRepo,
      runner: workspaceInstallRunner,
    });
    const id = nextHandoff();
    const handle = await manager.createWorktree(id, { isolated_install: true });

    try {
      expect(fs.lstatSync(path.join(handle.path, "node_modules")).isSymbolicLink()).toBe(false);

      const rediscovered = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
      const rediscoveredHandle = rediscovered.getWorktree(id);

      expect(rediscoveredHandle?.worktreeMode).toBe("isolated_install");
      expect(fs.lstatSync(path.join(handle.path, "node_modules")).isSymbolicLink()).toBe(false);
      const wtCore = fs.realpathSync.native(path.join(handle.path, "packages", "core"));
      expect(resolveWorkspaceLink(handle.path, "@penumbra/core")).toBe(wtCore);
    } finally {
      await manager.teardownWorktree(id, true);
    }
  });

  it("does not create an isolated worktree when bun install fails", async () => {
    const repoDir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "penumbra-wt-bad-repo-"));
    await exec("git init -b main", { cwd: repoDir });
    await exec('git config user.email "test@example.com"', { cwd: repoDir });
    await exec('git config user.name "test"', { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "package.json"), "{ not valid json\n");
    await exec("git add . && git commit -m init", { cwd: repoDir });

    const manager = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: repoDir });
    const id = nextHandoff();

    try {
      let createErr: unknown;
      try {
        await manager.createWorktree(id, { isolated_install: true });
      } catch (err) {
        createErr = err;
      }
      expect(createErr).toBeDefined();
      expect(manager.getWorktree(id)).toBeNull();
      expect(fs.existsSync(path.join(homeRoot, id))).toBe(false);
      const { stdout } = await exec(`git branch --list agent/${id}`, { cwd: repoDir });
      expect(stdout.trim()).toBe("");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(`${repoDir}-worktrees`, { recursive: true, force: true });
    }
  });

  it("isolated mode installs external file dependencies from a non-sibling worktree base", async () => {
    const { repoDir, externalPackageDir } = await setupRepoWithExternalFileDependency();
    const rootDir = fs.mkdtempSync(
      path.join(TEST_TMP_ROOT, "penumbra-wt-filedep-nonsibling-base-"),
    );
    const manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir });
    const id = nextHandoff();

    try {
      const handle = await manager.createWorktree(id, { isolated_install: true });
      const linkPath = path.join(rootDir, path.basename(externalPackageDir));

      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync.native(linkPath)).toBe(fs.realpathSync.native(externalPackageDir));
      expect(fs.existsSync(path.join(handle.path, "node_modules", "@fixture", "external"))).toBe(
        true,
      );

      const { stdout } = await exec("git status --short", { cwd: handle.path });
      expect(stdout.trim()).toBe("");

      await manager.teardownWorktree(id, true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(`${repoDir}-worktrees`, { recursive: true, force: true });
      fs.rmSync(externalPackageDir, { recursive: true, force: true });
    }
  });

  it("external file dependency link preparation is idempotent across worktrees in the same base", async () => {
    const { repoDir, externalPackageDir } = await setupRepoWithExternalFileDependency();
    const rootDir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "penumbra-wt-filedep-idem-base-"));
    const manager = new WorktreeManager({ rootDir, mainRepoDir: repoDir });
    const firstId = `${nextHandoff()}-a`;
    const secondId = `${nextHandoff()}-b`;

    try {
      const first = await manager.createWorktree(firstId, { isolated_install: true });
      const second = await manager.createWorktree(secondId, { isolated_install: true });
      const linkPath = path.join(rootDir, path.basename(externalPackageDir));

      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync.native(linkPath)).toBe(fs.realpathSync.native(externalPackageDir));

      await manager.teardownWorktree(firstId, true);
      await manager.teardownWorktree(secondId, true);
      expect(fs.existsSync(first.path)).toBe(false);
      expect(fs.existsSync(second.path)).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(`${repoDir}-worktrees`, { recursive: true, force: true });
      fs.rmSync(externalPackageDir, { recursive: true, force: true });
    }
  });
});
