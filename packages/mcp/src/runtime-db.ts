import {
  applyRuntimePragmas,
  loadSqliteVec,
  resolveDaemonStorageRoot,
  resolveStorageDbPath,
} from "@penumbra/core";
import { Database } from "bun:sqlite";

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
