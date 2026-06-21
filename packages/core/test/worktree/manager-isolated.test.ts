import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { exec as execCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { WorktreeManager } from "../../src/worktree/manager.js";

// node:util.promisify(child_process.exec)'s declaration overloads make TS pick
// the void-returning variant in eslint's type-aware pass; the runtime is in
// fact a Promise (per util.promisify.custom), so the explicit shape closes the
// gap without an `as any` dodge.
type ExecResult = { stdout: string; stderr: string };
type ExecOpts = { cwd?: string };
const exec: (command: string, opts?: ExecOpts) => Promise<ExecResult> = promisify(execCb);
const TSC_BIN = path.resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");

async function setupWorkspaceRepo(prefix: string): Promise<string> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await exec("git init -b main", { cwd: repoDir });
  await exec('git config user.email "test@example.com"', { cwd: repoDir });
  await exec('git config user.name "test"', { cwd: repoDir });

  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "test-root",
        type: "module",
        workspaces: ["packages/*"],
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

  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  await exec("git add . && git commit -m init", { cwd: repoDir });
  await exec("bun install", { cwd: repoDir });
  return repoDir;
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

describe("WorktreeManager isolated-install mode", () => {
  let homeRoot: string;
  let homeRepo: string;
  let counter = 0;

  beforeEach(async () => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-isolated-"));
    homeRepo = await setupWorkspaceRepo("penumbra-wt-repo-");
  });

  afterEach(() => {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    fs.rmSync(homeRepo, { recursive: true, force: true });
    fs.rmSync(`${homeRepo}-worktrees`, { recursive: true, force: true });
  });

  function nextHandoff(): string {
    return `wt-isolated-${String(Date.now())}-${String(++counter)}`;
  }

  it("default mode mirrors node_modules symlinks to main repo and keeps the stale-type trap", async () => {
    const manager = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
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
    const manager = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
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

  it("rediscovery preserves isolated worktree topology instead of remirroring node_modules", async () => {
    const manager = new WorktreeManager({ rootDir: homeRoot, mainRepoDir: homeRepo });
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
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-wt-bad-repo-"));
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
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(`${repoDir}-worktrees`, { recursive: true, force: true });
    }
  });
});
