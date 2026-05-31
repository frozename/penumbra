import { Database } from "bun:sqlite";
import { resolveDaemonStorageRoot } from "@penumbra/core";
import { resolveStorageDbPath } from "../../core/src/db/storage-db-path.js";

export async function withDaemonDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const storageRoot = resolveDaemonStorageRoot();
  const db = new Database(resolveStorageDbPath(storageRoot));
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
