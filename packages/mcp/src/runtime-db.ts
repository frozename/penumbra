import { applyRuntimePragmas, loadSqliteVec, resolveDaemonStorageRoot } from "@penumbra/core";
import { Database } from "bun:sqlite";

import { resolveStorageDbPath } from "../../core/src/db/storage-db-path.js";

export async function withDaemonDb<T>(fn: (db: Database) => Promise<T> | T): Promise<T> {
  const storageRoot = resolveDaemonStorageRoot();
  const db = new Database(resolveStorageDbPath(storageRoot));
  loadSqliteVec(db);
  applyRuntimePragmas(db);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
