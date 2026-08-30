import { backfillRecallFields, resolveStorageDbPath } from "@penumbra/core";
import { Database } from "bun:sqlite";

export interface RecallBackfillOpts {
  storageRoot: string;
}

export function runRecallBackfill(opts: RecallBackfillOpts): Promise<number> {
  const dbPath = resolveStorageDbPath(opts.storageRoot);
  const db = new Database(dbPath);
  try {
    const stats = backfillRecallFields(db);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return Promise.resolve(0);
  } finally {
    db.close();
  }
}
