import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';

export interface RunExportOpts {
  dbPath: string;
  project: string | null;
  outPath: string;
}

export async function runExport(opts: RunExportOpts): Promise<number> {
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    const lines: string[] = [];
    const tables = ['projects', 't0_events', 't1_rollups', 't2_memories'] as const;
    for (const table of tables) {
      const rows = opts.project
        ? db.query<Record<string, unknown>, [string]>(
            `SELECT * FROM ${table} WHERE project_id=?`,
          ).all(opts.project)
        : db.query<Record<string, unknown>, []>(
            `SELECT * FROM ${table}`,
          ).all();
      for (const row of rows) {
        lines.push(JSON.stringify({ table, row }));
      }
    }
    writeFileSync(opts.outPath, lines.join('\n') + '\n');
  } finally { db.close(); }
  return 0;
}
