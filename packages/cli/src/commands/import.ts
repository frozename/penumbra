import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

export interface RunImportOpts {
  dbPath: string;
  inPath: string;
}

const PK: Record<string, string> = {
  projects: "project_id",
  t0_events: "event_id",
  t1_rollups: "rollup_id",
  t2_memories: "memory_id",
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function runImportSync(opts: RunImportOpts): void {
  const db = new Database(opts.dbPath);
  try {
    db.run("BEGIN");
    try {
      const content = readFileSync(opts.inPath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const { table, row } = JSON.parse(line) as { table: string; row: Record<string, unknown> };
        const pk = PK[table];
        if (!pk) continue;
        const cols = Object.keys(row);
        const quotedCols = cols.map((c) => quoteIdentifier(c)).join(",");
        const placeholders = cols.map(() => "?").join(",");
        db.run(
          `INSERT INTO ${table}(${quotedCols}) VALUES(${placeholders}) ON CONFLICT(${quoteIdentifier(pk)}) DO NOTHING`,
          cols.map((c) => row[c] as string | number | null),
        );
      }
      db.run("COMMIT");
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* nothing to rollback */
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

export function runImport(opts: RunImportOpts): Promise<number> {
  try {
    runImportSync(opts);
    return Promise.resolve(0);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
