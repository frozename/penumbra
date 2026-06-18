import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyRuntimePragmas, loadSqliteVec, migrate, systemUuid, type Uuid } from "@penumbra/core";
import { AGENTCHAT_TEMPLATE } from "./init-agentchat-template.js";
import { resolveStorageDbPath } from "../../../core/src/db/storage-db-path.js";

export interface RunInitOpts {
  storageRoot: string;
  uuid?: Uuid;
  embeddingDim?: number;
  forceAgentchat?: boolean;
  claudeUserDir?: string;
  workflowsSourceDir?: string;
}

function resolveDefaultWorkflowsSourceDir(fromDir: string): string {
  let current = fromDir;
  while (true) {
    const candidate = join(current, ".claude/workflows");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return join(fromDir, ".claude/workflows");
    current = parent;
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

  const agentchatPath =
    process.env.AGENTCHAT_CONFIG ?? join(homedir(), ".config/agentchat/agentchat.yaml");
  if (existsSync(agentchatPath)) {
    if (opts.forceAgentchat) {
      mkdirSync(dirname(agentchatPath), { recursive: true });
      writeFileSync(agentchatPath, AGENTCHAT_TEMPLATE);
      process.stdout.write(`penumbra: seeded agentchat config at ${agentchatPath}\n`);
    } else {
      process.stdout.write(
        `penumbra: agentchat config exists at ${agentchatPath}; not overwriting\n`,
      );
    }
  } else {
    mkdirSync(dirname(agentchatPath), { recursive: true });
    writeFileSync(agentchatPath, AGENTCHAT_TEMPLATE);
    process.stdout.write(`penumbra: seeded agentchat config at ${agentchatPath}\n`);
  }

  const claudeUserDir = opts.claudeUserDir ?? join(homedir(), ".claude");
  const workflowsSourceDir =
    opts.workflowsSourceDir ?? resolveDefaultWorkflowsSourceDir(import.meta.dir);
  const workflowsTargetDir = join(claudeUserDir, "workflows");
  if (!existsSync(workflowsSourceDir)) {
    process.stdout.write(
      `penumbra: warning: workflows source dir not found at ${workflowsSourceDir}; skipping bundled workflow install\n`,
    );
  } else {
    const workflowFiles = readdirSync(workflowsSourceDir).filter((name) => /\.js$/.test(name));
    if (workflowFiles.length === 0) {
      process.stdout.write(
        `penumbra: warning: no bundled .js workflows found in ${workflowsSourceDir}; skipping bundled workflow install\n`,
      );
    } else {
      mkdirSync(workflowsTargetDir, { recursive: true });
      for (const name of workflowFiles) {
        const sourcePath = join(workflowsSourceDir, name);
        const targetPath = join(workflowsTargetDir, name);
        copyFileSync(sourcePath, targetPath);
        process.stdout.write(`penumbra: installed Claude workflow ${name} to ${targetPath}\n`);
      }
      process.stdout.write(
        `penumbra: installed ${workflowFiles.length} bundled workflow file(s) to ${workflowsTargetDir}\n`,
      );
    }
  }

  // Install the global Claude Code hooks + CLAUDE.md dispatch-discipline block so a
  // fresh `penumbra init` wires the memory/lifecycle hook (PreToolUse writer +
  // PostToolUse injector) and the standing dispatch-discipline prose without a manual
  // step. All three are idempotent and best-effort: init must never fail on them.
  try {
    const { runHooksInstallClaudeMemory, runHooksInstallClaudeMd } = await import("./hooks.js");

    // The memory/lifecycle hook POSTs to the daemon; only wire it when the daemon
    // has a port file (i.e. it has been started at least once). The hook itself is
    // best-effort at runtime — it no-ops when the daemon is down — but the installer
    // guards on the port file to avoid a confusing throw during first init.
    const portPath = join(opts.storageRoot, "port");
    if (existsSync(portPath)) {
      try {
        const r = await runHooksInstallClaudeMemory({
          claudeDir: claudeUserDir,
          storageRoot: opts.storageRoot,
        });
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
    } else {
      process.stdout.write(
        `penumbra: note: daemon not started yet; run \`penumbra hooks install --claude-memory\` after \`penumbra start\` to wire lifecycle hooks\n`,
      );
    }

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
  } catch (err) {
    process.stdout.write(`penumbra: warning: skipped hooks install: ${(err as Error).message}\n`);
  }

  process.stdout.write(`penumbra: initialized at ${opts.storageRoot}\n`);
  return 0;
}
