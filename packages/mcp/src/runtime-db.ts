import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { resolveDaemonStorageRoot } from '@penumbra/core';

export async function withDaemonDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const storageRoot = resolveDaemonStorageRoot();
  const db = new Database(join(storageRoot, 'db.sqlite'));
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}
