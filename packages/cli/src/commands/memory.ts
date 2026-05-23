import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseWikiLinks } from '@penumbra/core';

const DEFAULT_DIGEST_LIMIT = 200;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const CC_KINDS = new Set(['user', 'feedback', 'project', 'reference']);

interface MemoryDigestRow {
  slug: string;
  title: string;
  hook: string;
}

export interface MemoryImportSummaryRow {
  file: string;
  status: 'would_write' | 'skipped' | 'error';
  reason?: string;
  slug?: string;
  title?: string;
  hook?: string;
  cc_kind?: string;
  body?: string;
  body_preview?: string;
  wiki_links: string[];
  would_write: boolean;
}

export interface MemoryImportSummary {
  would_write: number;
  skipped: number;
  errors: number;
  rows: MemoryImportSummaryRow[];
  error?: 'root_not_found';
}

export interface RunMemoryImportOpts {
  root: string;
  dryRun: boolean;
  storageRoot?: string;
  db?: Database;
  print?: (line: string) => void;
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

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function bodyPreview(body: string, max = 140): string {
  return body.length <= max ? body : `${body.slice(0, max)}...`;
}

export function runMemoryImport(opts: RunMemoryImportOpts): MemoryImportSummary {
  if (!existsSync(opts.root) || !statSync(opts.root).isDirectory()) {
    return {
      would_write: 0,
      skipped: 0,
      errors: 0,
      rows: [],
      error: 'root_not_found',
    };
  }

  const print = opts.print ?? ((line: string) => process.stdout.write(line));
  const files = readdirSync(opts.root)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => statSync(join(opts.root, name)).isFile())
    .sort();

  const rows: MemoryImportSummaryRow[] = [];
  let wouldWrite = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const fullPath = join(opts.root, file);
    const content = readFileSync(fullPath, 'utf8');
    const match = content.match(FRONTMATTER_RE);

    if (!match) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: 'skipped',
        reason: 'no_frontmatter',
        wiki_links: [],
        would_write: false,
      };
      print(`SKIP ${file}: no_frontmatter\n`);
      rows.push(summary);
      skipped += 1;
      continue;
    }

    const rawFrontmatter = match[1] ?? '';
    const parsedBody = (match[2] ?? '').trim();
    const parsed = parseYaml(rawFrontmatter) as Record<string, unknown>;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: 'error',
        reason: 'invalid_frontmatter',
        wiki_links: [],
        would_write: false,
      };
      print(`ERROR ${file}: invalid_frontmatter\n`);
      rows.push(summary);
      errors += 1;
      continue;
    }

    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    const description = typeof parsed.description === 'string' ? parsed.description : undefined;
    const ccKind = metadata ? typeof metadata.type === 'string' ? metadata.type : undefined : undefined;

    if (!name || !description || !ccKind) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: 'skipped',
        reason: 'missing_required_fields',
        wiki_links: [],
        would_write: false,
      };
      print(`SKIP ${file}: missing_required_fields\n`);
      rows.push(summary);
      skipped += 1;
      continue;
    }

    if (!CC_KINDS.has(ccKind)) {
      const summary: MemoryImportSummaryRow = {
        file,
        status: 'error',
        reason: 'unknown_cc_kind',
        wiki_links: [],
        would_write: false,
      };
      print(`ERROR ${file}: unknown_cc_kind\n`);
      rows.push(summary);
      errors += 1;
      continue;
    }

    const slug = slugify(name);
    const links = parseWikiLinks(parsedBody);
    const summary: MemoryImportSummaryRow = {
      file,
      status: 'would_write',
      slug,
      title: name,
      hook: description,
      cc_kind: ccKind,
      body: parsedBody,
      body_preview: bodyPreview(parsedBody),
      wiki_links: links,
      would_write: true,
    };

    rows.push(summary);
    wouldWrite += 1;
    print(`WRITE ${file}: slug=${slug} kind=${ccKind}\n`);
  }

  return {
    would_write: wouldWrite,
    skipped,
    errors,
    rows,
  };
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
