import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { WorkflowFn, WorkflowSpec } from '@penumbra/workflows';

const DIGEST_HEADER = '# Maestro memory digest (auto-loaded by penumbra)';
const DEFAULT_MAX_LINES = 200;

const DIGEST_QUERY = `
  SELECT slug, title, hook
  FROM t2_memories
  WHERE origin = ?
    AND retired_at IS NULL
    AND slug IS NOT NULL
    AND hook IS NOT NULL
    AND project_id IS NULL
  ORDER BY updated_at DESC
  LIMIT ?
`;

type MemoryDigestRow = {
  slug: string | null;
  title: string | null;
  hook: string | null;
};

const spec: WorkflowSpec = {
  name: 'memory-digest',
  description:
    'Surface the active maestro-scoped t2 memory digest as session-start additionalContext, the penumbra-native equivalent of Claude Code\'s auto-memory MEMORY.md.',
  triggers: [{ kind: 'lifecycle', event: 'session-start' }],
  recall: [],
  output: [{ kind: 'session-reminder' }],
  run: { kind: 'ts-function' },
};

function resolveLimit(): number {
  const raw = process.env.PENUMBRA_MEMORY_DIGEST_MAX_LINES;
  if (!raw) return DEFAULT_MAX_LINES;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_MAX_LINES;
  return value;
}

function toMarkdownRow(row: { title: string; slug: string; hook: string }): string {
  return `- [${row.title}](${row.slug}) — ${row.hook}`;
}

export const fn: WorkflowFn = async (ctx) => {
  // WorkflowCtx doesn't expose `services.db` — open the daemon's DB from
  // ctx.storageRoot directly (same pattern as packages/cli/src/commands/memory.ts's
  // runMemoryDigest). Tests can inject a pre-opened DB via ctx.args.db.
  const injected = (ctx.args as { db?: Database } | undefined)?.db;
  const db =
    injected ?? new Database(join(ctx.storageRoot, 'db.sqlite'), { readonly: true });
  const shouldClose = !injected;

  let rows: MemoryDigestRow[];
  try {
    rows = db
      .query<MemoryDigestRow, [string, number]>(DIGEST_QUERY)
      .all('direct', resolveLimit());
  } finally {
    if (shouldClose) db.close();
  }

  const lines = rows
    .filter(
      (row): row is { title: string; slug: string; hook: string } =>
        typeof row.title === 'string' && typeof row.slug === 'string' && typeof row.hook === 'string',
    )
    .map(toMarkdownRow);

  if (lines.length === 0) return '';
  return `${DIGEST_HEADER}\n\n${lines.join('\n')}`;
};

export default spec;
