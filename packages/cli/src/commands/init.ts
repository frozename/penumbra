import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyRuntimePragmas, loadSqliteVec, migrate, systemUuid, type Uuid } from "@penumbra/core";
import { AGENTCHAT_TEMPLATE } from "./init-agentchat-template.js";

export interface RunInitOpts {
  storageRoot: string;
  uuid?: Uuid;
  embeddingDim?: number;
  forceAgentchat?: boolean;
}

export async function runInit(opts: RunInitOpts): Promise<number> {
  const uuid = opts.uuid ?? systemUuid;
  mkdirSync(opts.storageRoot, { recursive: true });

  const tokenPath = join(opts.storageRoot, "token");
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, `${uuid()}\n`, { mode: 0o600 });
  }

  const dbPath = join(opts.storageRoot, "db.sqlite");
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

  process.stdout.write(`penumbra: initialized at ${opts.storageRoot}\n`);
  return 0;
}
