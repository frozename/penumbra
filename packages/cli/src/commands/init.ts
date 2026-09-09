import { applyRuntimePragmas, loadSqliteVec, migrate, systemUuid, type Uuid } from "@penumbra/core";
import { resolveStorageDbPath } from "@penumbra/core";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

import { AGENTCHAT_TEMPLATE } from "./init-agentchat-template.js";

export interface RunInitOpts {
  storageRoot: string;
  uuid?: Uuid;
  embeddingDim?: number;
  forceAgentchat?: boolean;
  claudeUserDir?: string;
  workflowsSourceDir?: string;
}

// A `.claude/worktrees/<id>` checkout carries its own tracked `.claude/workflows`.
// Seeding the global mirror from there publishes unlanded work, and three mirror
// entries are symlinks back into the main checkout — so the copy would land in
// main's tracked source. Skip any candidate under a worktree and keep climbing.
const WORKTREE_SEGMENT = `${sep}.claude${sep}worktrees${sep}`;

// Path shape alone cannot fence this: fleet worktrees live at
// `<root>-worktrees/<uuid>`, outside `.claude/worktrees/`. The structural signal is
// that a linked checkout — a `git worktree` of any layout, a submodule, any
// `.git`-file setup — has `.git` as a FILE containing a `gitdir:` pointer at its
// root, while a main checkout has `.git` as a DIRECTORY. Find the nearest enclosing
// `.git` and fail closed: non-directory or unreadable means linked — skip.
function isLinkedCheckout(dir: string): boolean {
  let current = dir;
  for (;;) {
    try {
      const gitEntry = lstatSync(join(current, ".git"), { throwIfNoEntry: false });
      if (gitEntry !== undefined) return !gitEntry.isDirectory();
    } catch {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function resolveDefaultWorkflowsSourceDir(fromDir: string): string {
  let current = fromDir;
  for (;;) {
    const candidate = join(current, ".claude/workflows");
    if (
      existsSync(candidate) &&
      !`${candidate}${sep}`.includes(WORKTREE_SEGMENT) &&
      !isLinkedCheckout(current)
    ) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return join(fromDir, ".claude/workflows");
    current = parent;
  }
}

function seedAgentchatConfig(forceAgentchat: boolean | undefined): void {
  const agentchatPath =
    process.env.AGENTCHAT_CONFIG ?? join(homedir(), ".config/agentchat/agentchat.yaml");
  const exists = existsSync(agentchatPath);
  if (exists && !forceAgentchat) {
    process.stdout.write(
      `penumbra: agentchat config exists at ${agentchatPath}; not overwriting\n`,
    );
    return;
  }
  mkdirSync(dirname(agentchatPath), { recursive: true });
  writeFileSync(agentchatPath, AGENTCHAT_TEMPLATE);
  process.stdout.write(`penumbra: seeded agentchat config at ${agentchatPath}\n`);
}

function installBundledWorkflows(workflowsSourceDir: string, claudeUserDir: string): void {
  const workflowsTargetDir = join(claudeUserDir, "workflows");
  if (!existsSync(workflowsSourceDir)) {
    process.stdout.write(
      `penumbra: warning: workflows source dir not found at ${workflowsSourceDir}; skipping bundled workflow install\n`,
    );
    return;
  }
  const workflowFiles = readdirSync(workflowsSourceDir).filter((name) => name.endsWith(".js"));
  if (workflowFiles.length === 0) {
    process.stdout.write(
      `penumbra: warning: no bundled .js workflows found in ${workflowsSourceDir}; skipping bundled workflow install\n`,
    );
    return;
  }
  mkdirSync(workflowsTargetDir, { recursive: true });
  let copied = 0;
  let linked = 0;
  for (const name of workflowFiles) {
    const sourcePath = join(workflowsSourceDir, name);
    const targetPath = join(workflowsTargetDir, name);
    // lstat, not existsSync: existsSync is false for a DANGLING symlink, and
    // copyFileSync onto a dangling link creates the link's target — outside this
    // directory. Fail closed on any symlink, live or dangling.
    const targetStat = lstatSync(targetPath, { throwIfNoEntry: false });
    if (targetStat?.isSymbolicLink()) {
      linked++;
      process.stdout.write(
        `penumbra: left Claude workflow ${name} in place; ${targetPath} is a symlink and is already live\n`,
      );
      continue;
    }
    copyFileSync(sourcePath, targetPath);
    copied++;
    process.stdout.write(`penumbra: installed Claude workflow ${name} to ${targetPath}\n`);
  }
  process.stdout.write(
    `penumbra: installed ${String(copied)} bundled workflow file(s) to ${workflowsTargetDir}${
      linked > 0 ? `; ${String(linked)} symlinked entries left in place` : ""
    }\n`,
  );
}

async function installClaudeMemoryHook(
  runHooksInstallClaudeMemory: (args: {
    claudeDir: string;
    storageRoot: string;
  }) => Promise<{ idempotent?: boolean; events: string[] }>,
  storageRoot: string,
  claudeUserDir: string,
): Promise<void> {
  const portPath = join(storageRoot, "port");
  if (!existsSync(portPath)) {
    process.stdout.write(
      `penumbra: note: daemon not started yet; run \`penumbra hooks install --claude-memory\` after \`penumbra start\` to wire lifecycle hooks\n`,
    );
    return;
  }
  try {
    const r = await runHooksInstallClaudeMemory({ claudeDir: claudeUserDir, storageRoot });
    process.stdout.write(
      r.idempotent
        ? `penumbra: claude memory hooks already current (${r.events.join(", ")})\n`
        : `penumbra: installed claude memory hooks for ${r.events.join(", ")}\n`,
    );
  } catch (err) {
    process.stdout.write(
      `penumbra: warning: skipped claude memory hook install: ${(err as Error).message}\n`,
    );
  }
}

async function installClaudeMdBlock(
  runHooksInstallClaudeMd: (args: {
    claudeDir: string;
  }) => Promise<{ idempotent?: boolean; path: string }>,
  claudeUserDir: string,
): Promise<void> {
  try {
    const md = await runHooksInstallClaudeMd({ claudeDir: claudeUserDir });
    process.stdout.write(
      md.idempotent
        ? `penumbra: dispatch-discipline CLAUDE.md block already current at ${md.path}\n`
        : `penumbra: installed dispatch-discipline CLAUDE.md block at ${md.path}\n`,
    );
  } catch (err) {
    process.stdout.write(
      `penumbra: warning: skipped CLAUDE.md dispatch-discipline install: ${(err as Error).message}\n`,
    );
  }
}

export async function runInit(opts: RunInitOpts): Promise<number> {
  const uuid = opts.uuid ?? systemUuid;
  mkdirSync(opts.storageRoot, { recursive: true });

  const tokenPath = join(opts.storageRoot, "token");
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, `${uuid()}\n`, { mode: 0o600 });
  }

  const dbPath = resolveStorageDbPath(opts.storageRoot);
  const db = new Database(dbPath, { create: true });
  try {
    loadSqliteVec(db);
    applyRuntimePragmas(db);
    migrate(db, { embeddingDim: opts.embeddingDim ?? 384 });
  } finally {
    db.close();
  }

  seedAgentchatConfig(opts.forceAgentchat);

  const claudeUserDir =
    opts.claudeUserDir ?? process.env.PENUMBRA_CLAUDE_USER_DIR ?? join(homedir(), ".claude");
  const workflowsSourceDir =
    opts.workflowsSourceDir ?? resolveDefaultWorkflowsSourceDir(import.meta.dir);
  installBundledWorkflows(workflowsSourceDir, claudeUserDir);

  // Install the global Claude Code hooks + CLAUDE.md dispatch-discipline block so a
  // fresh `penumbra init` wires the memory/lifecycle hook and the standing
  // dispatch-discipline prose without a manual step. All three are idempotent and
  // best-effort: init must never fail on them.
  try {
    const { runHooksInstallClaudeMemory, runHooksInstallClaudeMd } = await import("./hooks.js");
    await installClaudeMemoryHook(runHooksInstallClaudeMemory, opts.storageRoot, claudeUserDir);
    await installClaudeMdBlock(runHooksInstallClaudeMd, claudeUserDir);
  } catch (err) {
    process.stdout.write(`penumbra: warning: skipped hooks install: ${(err as Error).message}\n`);
  }

  process.stdout.write(`penumbra: initialized at ${opts.storageRoot}\n`);
  return 0;
}
