import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

export interface RunImportOpts {
  dbPath: string;
  inPath: string;
}

const PK: Record<string, string> = {
  projects: 'project_id',
  t0_events: 'event_id',
  t1_rollups: 'rollup_id',
  t2_memories: 'memory_id',
};

export async function runImport(opts: RunImportOpts): Promise<number> {
  const db = new Database(opts.dbPath);
  try {
    db.exec('BEGIN');
    const content = readFileSync(opts.inPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const { table, row } = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      const pk = PK[table];
      if (!pk) continue;
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(',');
      db.run(
        `INSERT INTO ${table}(${cols.join(',')}) VALUES(${placeholders}) ON CONFLICT(${pk}) DO NOTHING`,
        cols.map((c) => row[c] as string | number | null) as (string | number | null)[],
      );
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  return 0;
}
