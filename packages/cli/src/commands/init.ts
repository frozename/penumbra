import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyRuntimePragmas,
  loadSqliteVec,
  migrate,
  systemUuid,
  type Uuid,
} from "@penumbra/core";
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
    if (existsSync(candidate))
      return candidate;
    const parent = dirname(current);
    if (parent === current)
      return join(fromDir, ".claude/workflows");
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
      process.stdout.write(`penumbra: agentchat config exists at ${agentchatPath}; not overwriting\n`);
    }
  } else {
    mkdirSync(dirname(agentchatPath), { recursive: true });
    writeFileSync(agentchatPath, AGENTCHAT_TEMPLATE);
    process.stdout.write(`penumbra: seeded agentchat config at ${agentchatPath}\n`);
  }

  const claudeUserDir = opts.claudeUserDir ?? join(homedir(), ".claude");
  const workflowsSourceDir = opts.workflowsSourceDir ?? resolveDefaultWorkflowsSourceDir(import.meta.dir);
  const workflowsTargetDir = join(claudeUserDir, "workflows");
  if (!existsSync(workflowsSourceDir)) {
    process.stdout.write(
      `penumbra: warning: workflows source dir not found at ${workflowsSourceDir}; skipping bundled workflow install\n`,
    );
  } else {
    const workflowFiles = readdirSync(workflowsSourceDir).filter((name) =>
      /^penumbra-.*\.js$/.test(name),
    );
    if (workflowFiles.length === 0) {
      process.stdout.write(
        `penumbra: warning: no bundled workflows matching penumbra-*.js in ${workflowsSourceDir}; skipping install\n`,
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

  process.stdout.write(`penumbra: initialized at ${opts.storageRoot}\n`);
  return 0;
}
