import { Database } from "bun:sqlite";
import { join } from "node:path";
import { backfillRecallFields } from "@penumbra/core";

export interface RecallBackfillOpts {
  storageRoot: string;
}

export async function runRecallBackfill(opts: RecallBackfillOpts): Promise<number> {
  const dbPath = join(opts.storageRoot, "db.sqlite");
  const db = new Database(dbPath);
  try {
    const stats = backfillRecallFields(db);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return 0;
  } finally {
    db.close();
  }
}
