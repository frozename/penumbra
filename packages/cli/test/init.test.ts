import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDefaultWorkflowsSourceDir, runInit } from "../src/commands/init.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let dir = "";
let claudeUserDir = "";
let workflowsSourceDir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-init-"));
  claudeUserDir = mkdtempSync(join(tmpdir(), "penumbra-cli-claude-user-"));
  workflowsSourceDir = mkdtempSync(join(tmpdir(), "penumbra-cli-workflows-src-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(claudeUserDir, { recursive: true, force: true });
  rmSync(workflowsSourceDir, { recursive: true, force: true });
});

test("init creates storage root, token, and DB file", async () => {
  const exit = await runInit({
    storageRoot: dir,
    uuid: () => "tok-123",
    claudeUserDir,
    workflowsSourceDir,
  });
  expect(exit).toBe(0);
  expect(existsSync(join(dir, "token"))).toBe(true);
  expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe("tok-123");
  expect(existsSync(join(dir, "db.sqlite"))).toBe(true);
});

test("init is idempotent — running twice keeps the same token", async () => {
  await runInit({ storageRoot: dir, uuid: () => "tok-1", claudeUserDir, workflowsSourceDir });
  const first = readFileSync(join(dir, "token"), "utf8").trim();
  await runInit({ storageRoot: dir, uuid: () => "tok-2", claudeUserDir, workflowsSourceDir });
  const second = readFileSync(join(dir, "token"), "utf8").trim();
  expect(second).toBe(first);
});

test("init installs the dispatch-discipline CLAUDE.md block in the temp claudeUserDir", async () => {
  // Covers the runInit -> runHooksInstallClaudeMd path (called unconditionally), and
  // confirms it writes into the supplied claudeUserDir, never the real ~/.claude.
  const exit = await runInit({
    storageRoot: dir,
    uuid: () => "tok-md",
    claudeUserDir,
    workflowsSourceDir,
  });
  expect(exit).toBe(0);
  const mdPath = join(claudeUserDir, "CLAUDE.md");
  expect(existsSync(mdPath)).toBe(true);
  const body = readFileSync(mdPath, "utf8");
  expect(body).toContain("managed [dispatch-discipline] block");
  expect(body).toContain("Dispatch discipline (penumbra)");
  // The registrar rule ships globally with every install, not just in this repo's AGENTS.md.
  expect(body).toContain("Registrar discipline (penumbra)");
});

test("init copies bundled penumbra workflows into claude user workflows dir", async () => {
  writeFileSync(join(workflowsSourceDir, "penumbra-fanout.js"), "export default 'fanout';\n");
  writeFileSync(join(workflowsSourceDir, "penumbra-swarm.js"), "export default 'swarm';\n");
  writeFileSync(join(workflowsSourceDir, "other.md"), "# other\n");

  const targetDir = join(claudeUserDir, "workflows");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "keep-me.js"), "export default 'keep';\n", { flag: "wx" });

  const exit = await runInit({
    storageRoot: dir,
    uuid: () => "tok-123",
    claudeUserDir,
    workflowsSourceDir,
  });
  expect(exit).toBe(0);
  expect(readFileSync(join(targetDir, "penumbra-fanout.js"), "utf8")).toBe(
    "export default 'fanout';\n",
  );
  expect(readFileSync(join(targetDir, "penumbra-swarm.js"), "utf8")).toBe(
    "export default 'swarm';\n",
  );
  expect(existsSync(join(targetDir, "other.md"))).toBe(false);
  expect(readFileSync(join(targetDir, "keep-me.js"), "utf8")).toBe("export default 'keep';\n");
});

test("init copies all .js workflows including non-prefixed ones", async () => {
  writeFileSync(join(workflowsSourceDir, "penumbra-fanout.js"), "export default 'fanout';\n");
  writeFileSync(join(workflowsSourceDir, "land-and-close.js"), "export default 'land';\n");
  writeFileSync(join(workflowsSourceDir, "adversarial-review.js"), "export default 'ar';\n");
  writeFileSync(join(workflowsSourceDir, "integration-audit.js"), "export default 'ia';\n");
  writeFileSync(join(workflowsSourceDir, "README.md"), "# docs\n");

  const targetDir = join(claudeUserDir, "workflows");
  const exit = await runInit({
    storageRoot: dir,
    uuid: () => "tok-all",
    claudeUserDir,
    workflowsSourceDir,
  });
  expect(exit).toBe(0);
  expect(readFileSync(join(targetDir, "penumbra-fanout.js"), "utf8")).toBe(
    "export default 'fanout';\n",
  );
  expect(readFileSync(join(targetDir, "land-and-close.js"), "utf8")).toBe(
    "export default 'land';\n",
  );
  expect(readFileSync(join(targetDir, "adversarial-review.js"), "utf8")).toBe(
    "export default 'ar';\n",
  );
  expect(readFileSync(join(targetDir, "integration-audit.js"), "utf8")).toBe(
    "export default 'ia';\n",
  );
  expect(existsSync(join(targetDir, "README.md"))).toBe(false);
});

test("init does not copy through a symlinked mirror entry", async () => {
  // Three real ~/.claude/workflows entries are symlinks into the main checkout.
  // copyFileSync follows a symlinked DESTINATION, so a plain copy rewrites the
  // link target — i.e. main's tracked source — from an unlanded worktree.
  const canaryDir = mkdtempSync(join(tmpdir(), "penumbra-cli-canary-"));
  const canary = join(canaryDir, "penumbra-swarm.js");
  writeFileSync(canary, "export default 'MAIN-CHECKOUT';\n");
  writeFileSync(join(workflowsSourceDir, "penumbra-swarm.js"), "export default 'FROM-WORKTREE';\n");

  const targetDir = join(claudeUserDir, "workflows");
  mkdirSync(targetDir, { recursive: true });
  symlinkSync(canary, join(targetDir, "penumbra-swarm.js"));

  try {
    const exit = await runInit({
      storageRoot: dir,
      uuid: () => "tok-symlink",
      claudeUserDir,
      workflowsSourceDir,
    });
    expect(exit).toBe(0);
    expect(readFileSync(canary, "utf8")).toBe("export default 'MAIN-CHECKOUT';\n");
    expect(lstatSync(join(targetDir, "penumbra-swarm.js")).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(canaryDir, { recursive: true, force: true });
  }
});

test("the default workflows source dir never resolves inside a worktree", () => {
  // Run from .claude/worktrees/<id>/..., the upward walk must skip the worktree's
  // own .claude/workflows and keep climbing to the main checkout, so an unlanded
  // branch can never seed the global mirror.
  const root = mkdtempSync(join(tmpdir(), "penumbra-cli-worktree-"));
  try {
    const mainWorkflows = join(root, ".claude/workflows");
    const worktreeWorkflows = join(root, ".claude/worktrees/wt-1/.claude/workflows");
    const from = join(root, ".claude/worktrees/wt-1/packages/cli/src/commands");
    mkdirSync(mainWorkflows, { recursive: true });
    mkdirSync(worktreeWorkflows, { recursive: true });
    mkdirSync(from, { recursive: true });

    expect(resolveDefaultWorkflowsSourceDir(from)).toBe(mainWorkflows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default workflows source dir skips a fleet <root>-worktrees/<uuid> linked worktree", () => {
  // Fleet worktrees live at `<root>-worktrees/<uuid>` — OUTSIDE
  // `.claude/worktrees/`, so the path-segment fence cannot see them. The
  // structural fence can: a linked worktree's `.git` is a FILE containing a
  // `gitdir:` pointer, not a directory. The worktree's own .claude/workflows
  // must be skipped; with no non-worktree candidate above it, the walk falls
  // through to the fromDir fallback (which does not exist → init warns and
  // installs nothing — fail closed).
  const root = mkdtempSync(join(tmpdir(), "penumbra-cli-fleet-wt-"));
  const worktreesBase = `${root}-worktrees`;
  try {
    const worktreeRoot = join(worktreesBase, "5192186a-222a-441f-b9d1-3f9429b55bbc");
    const worktreeWorkflows = join(worktreeRoot, ".claude/workflows");
    const from = join(worktreeRoot, "packages/cli/src/commands");
    mkdirSync(worktreeWorkflows, { recursive: true });
    mkdirSync(from, { recursive: true });
    writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${join(root, ".git/worktrees/fleet")}\n`);

    const resolved = resolveDefaultWorkflowsSourceDir(from);
    expect(resolved).not.toBe(worktreeWorkflows);
    expect(resolved).toBe(join(from, ".claude/workflows"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(worktreesBase, { recursive: true, force: true });
  }
});

test("the default workflows source dir climbs out of a linked worktree to an enclosing checkout", () => {
  // A linked worktree nested at a non-`.claude/worktrees/` path under a main
  // checkout: the worktree's candidate is skipped and the walk continues to the
  // enclosing main checkout's .claude/workflows.
  const root = mkdtempSync(join(tmpdir(), "penumbra-cli-nested-wt-"));
  try {
    const mainWorkflows = join(root, ".claude/workflows");
    const worktreeRoot = join(root, "nested-checkout");
    const worktreeWorkflows = join(worktreeRoot, ".claude/workflows");
    const from = join(worktreeRoot, "packages/cli/src/commands");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(mainWorkflows, { recursive: true });
    mkdirSync(worktreeWorkflows, { recursive: true });
    mkdirSync(from, { recursive: true });
    writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${join(root, ".git/worktrees/nested")}\n`);

    expect(resolveDefaultWorkflowsSourceDir(from)).toBe(mainWorkflows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default workflows source dir accepts a normal main checkout (.git directory)", () => {
  // Happy path: `penumbra init` on a fresh normal machine must still install.
  // A main checkout has `.git` as a DIRECTORY, so the fence must not fire.
  const root = mkdtempSync(join(tmpdir(), "penumbra-cli-main-"));
  try {
    const mainWorkflows = join(root, ".claude/workflows");
    const from = join(root, "packages/cli/src/commands");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(mainWorkflows, { recursive: true });
    mkdirSync(from, { recursive: true });

    expect(resolveDefaultWorkflowsSourceDir(from)).toBe(mainWorkflows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
