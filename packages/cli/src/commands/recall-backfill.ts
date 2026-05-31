import { Database } from "bun:sqlite";
import { backfillRecallFields } from "@penumbra/core";
import { resolveStorageDbPath } from "../../../core/src/db/storage-db-path.js";

export interface RecallBackfillOpts {
  storageRoot: string;
}

export async function runRecallBackfill(opts: RecallBackfillOpts): Promise<number> {
  const dbPath = resolveStorageDbPath(opts.storageRoot);
  const db = new Database(dbPath);
  try {
    const stats = backfillRecallFields(db);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return 0;
  } finally {
    db.close();
  }
}
