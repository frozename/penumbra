import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const DEFAULT_DIGEST_LIMIT = 200;

interface MemoryDigestRow {
  slug: string;
  title: string;
  hook: string;
}

export interface RunMemoryDigestOpts {
  maestro?: boolean;
  limit?: number;
  storageRoot: string;
  db?: Database;
  print?: (line: string) => void;
}

function resolveLimit(limit: number | undefined): number {
  const resolvedLimit = limit ?? DEFAULT_DIGEST_LIMIT;
  if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1) {
    throw new Error(`penumbra memory digest: --limit must be a positive integer (got: ${resolvedLimit})`);
  }
  return resolvedLimit;
}

export function runMemoryDigest(opts: RunMemoryDigestOpts): number {
  const limit = resolveLimit(opts.limit);
  const print = opts.print ?? ((line: string) => process.stdout.write(line));
  const shouldClose = !opts.db;

  const db = opts.db ?? new Database(join(opts.storageRoot, 'db.sqlite'), { readonly: true });
  try {
    const rows = db.query<MemoryDigestRow, [string, number]>(`
      SELECT slug, title, hook
      FROM t2_memories
      WHERE origin = ?
        AND retired_at IS NULL
        AND slug IS NOT NULL
        AND hook IS NOT NULL
        ${opts.maestro ? 'AND project_id IS NULL' : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all('direct', limit);

    for (const row of rows) {
      print(`- [${row.title}](${row.slug}) — ${row.hook}\n`);
    }
    return 0;
  } finally {
    if (shouldClose) {
      db.close();
    }
  }
}

