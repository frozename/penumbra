import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TestEmbedder } from '@penumbra/core/testing';
import { buildServices, loadSqliteVec, migrate } from '@penumbra/core';
import { createDaemonFetchHandler } from '../../../daemon/src/serve.js';
import { runMemoryImport } from '../../src/commands/memory.js';

let root = '';
let db: Database;
let createdMemoryDbDir = '';

function ccFile(name: string, options: { description: string; type: string; body: string }): string {
  return `---\nname: ${name}\ndescription: ${options.description}\nmetadata:\n  type: ${options.type}\n---\n\n${options.body}`;
}

function writeMemoryFile(file: string, content: string): void {
  writeFileSync(join(root, file), content);
}

function makeStorageRoot(): string {
  const storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-memory-import-daemon-'));
  writeFileSync(join(storageRoot, 'port'), '4242');
  writeFileSync(join(storageRoot, 'token'), 'tok');
  return storageRoot;
}

function setupMemoryDaemon(): {
  storageRoot: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  db: Database;
  stop: () => void;
} {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const storageRoot = makeStorageRoot();
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });

  const handler = createDaemonFetchHandler({ services, token: 'tok' });
  createdMemoryDbDir = storageRoot;
  return {
    storageRoot,
    db,
    fetch: (path, init = {}) => {
      const parsed = new URL(path);
      const rel = `${parsed.pathname}${parsed.search}`;
      const request = new Request(`http://x${rel}`, {
        ...init,
        headers: {
          ...((init as RequestInit).headers ?? {}),
          authorization: `Bearer tok`,
        },
      });
      return handler(request);
    },
    stop: () => {
      try {
        services.supervisor.stopAll();
      } catch {}
      try {
        db.close();
      } catch {}
      try {
        rmSync(storageRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

function parseLinksFromSlugRows(storageDb: Database, srcSlug: string): Array<{ link_type: string; raw_slug: string | null; dst_id: string | null }> {
  const rows = storageDb
    .query<{ link_type: string; raw_slug: string | null; dst_id: string | null }, [string]>(
      `
      SELECT ml.link_type, ml.raw_slug, ml.dst_id
      FROM memory_links ml
      JOIN t2_memories m ON m.memory_id = ml.src_id
      WHERE m.slug = ?
    `,
    )
    .all(srcSlug);
  return rows;
}

function queryMemoryCount(storageDb: Database, slugs: string[]): number {
  if (slugs.length === 0) return 0;
  const marks = slugs.map(() => '?').join(', ');
  const row = storageDb
    .prepare(`SELECT COUNT(*) AS count FROM t2_memories WHERE origin = 'direct' AND slug IN (${marks})`)
    .get(...slugs) as { count: number };
  return row.count;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'penumbra-memory-import-'));
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

afterEach(() => {
  if (db) db.close();
  if (root) rmSync(root, { recursive: true, force: true });
  if (createdMemoryDbDir && existsSync(createdMemoryDbDir)) {
    rmSync(createdMemoryDbDir, { recursive: true, force: true });
  }
  createdMemoryDbDir = '';
});

describe('runMemoryImport', () => {
  test('dry-run parses frontmatter and reports counts for valid files', async () => {
    let printed = '';
    writeMemoryFile('first.md', ccFile('first-entry', {
      description: 'First imported memory',
      type: 'feedback',
      body: 'This is a valid CC memory body.',
    }));
    writeMemoryFile('second.md', ccFile('second-entry', {
      description: 'Second imported memory',
      type: 'user',
      body: 'Another valid CC memory body.',
    }));
    writeMemoryFile('third.md', ccFile('third-entry', {
      description: 'Third imported memory',
      type: 'project',
      body: 'Third valid CC memory body.',
    }));

    const result = await runMemoryImport({ root, dryRun: true, apply: false, print: (line) => { printed += line; } });
    expect(result).toEqual(expect.objectContaining({ would_write: 3, skipped: 0, errors: 0 }));
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.status === 'would_write')).toBe(true);
    expect(printed).toContain('WRITE first.md');
  });

  test('dry-run does not write rows to t2_memories', async () => {
    writeMemoryFile('keep-same.md', ccFile('keep-same', {
      description: 'Will not be written during dry-run',
      type: 'reference',
      body: 'This memory stays unwritten in dry-run mode.',
    }));

    const before = (db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM t2_memories').get() as { count: number }).count;
    const result = await runMemoryImport({ root, dryRun: true, apply: false, db });
    const after = (db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM t2_memories').get() as { count: number }).count;

    expect(result.would_write).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.skipped).toBe(0);
    expect(after).toBe(before);
  });

  test('skip files without frontmatter', async () => {
    writeMemoryFile('foo.md', 'This file is missing frontmatter and should be skipped.');
    const result = await runMemoryImport({ root, dryRun: true, apply: false });

    expect(result.would_write).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ file: 'foo.md', status: 'skipped', reason: 'no_frontmatter' });
  });

  test('reject invalid cc_kind values', async () => {
    writeMemoryFile('invalid.md', ccFile('invalid-kind', {
      description: 'Bad kind',
      type: 'invalid-kind',
      body: 'This has an invalid metadata type.',
    }));

    const result = await runMemoryImport({ root, dryRun: true, apply: false });

    expect(result.would_write).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ file: 'invalid.md', status: 'error', reason: 'unknown_cc_kind' });
  });

  test('extract [[backlink]] references from body', async () => {
    writeMemoryFile('links.md', ccFile('link-memory', {
      description: 'Has a backlink',
      type: 'feedback',
      body: 'This memory links to [[some-other-slug]] and [[another-slug]].',
    }));

    const result = await runMemoryImport({ root, dryRun: true, apply: false });
    const row = result.rows[0];

    expect(row?.status).toBe('would_write');
    expect(row?.wiki_links).toEqual(['some-other-slug', 'another-slug']);
  });

  test('frontmatter maps to expected row shape', async () => {
    writeMemoryFile('map.md', ccFile('feedback-dispatch-must-pin-event-bus-types', {
      description: 'When a dispatch needs to subscribe to events...',
      type: 'feedback',
      body: 'body-body-body markdown',
    }));

    const result = await runMemoryImport({ root, dryRun: true, apply: false });
    const row = result.rows[0];

    expect(row).toMatchObject({
      file: 'map.md',
      status: 'would_write',
      slug: 'feedback-dispatch-must-pin-event-bus-types',
      title: 'feedback-dispatch-must-pin-event-bus-types',
      hook: 'When a dispatch needs to subscribe to events...',
      cc_kind: 'feedback',
      body: 'body-body-body markdown',
      body_preview: 'body-body-body markdown',
    });
  });

  test('invalid root fails with root_not_found and does not run', async () => {
    const result = await runMemoryImport({ root: '/non/existent/path', dryRun: true, apply: false });
    expect(result.error).toBe('root_not_found');
    expect(result.would_write).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    const cli = join(process.cwd(), 'packages/cli/bin/penumbra.ts');
    const proc = spawnSync('bun', [cli, 'memory', 'import-from-claude-code', '--root', '/non/existent/path', '--dry-run'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(proc.status).not.toBe(0);
    expect(proc.stderr ?? '').toContain('root_not_found');
  });

  test('apply -- imports entries through daemon /memory/write and writes direct memories', async () => {
    const daemon = setupMemoryDaemon();
    try {
      writeMemoryFile('first.md', ccFile('first-entry', {
        description: 'Import one',
        type: 'feedback',
        body: 'First body',
      }));
      writeMemoryFile('second.md', ccFile('second-entry', {
        description: 'Import two',
        type: 'project',
        body: 'Second body',
      }));

      const calls: Array<{ url: string; method?: string }> = [];
      const result = await runMemoryImport({
        root,
        dryRun: false,
        apply: true,
        storageRoot: daemon.storageRoot,
        fetch: async (url, init) => {
          calls.push({ url: String(url), method: init?.method });
          return daemon.fetch(url, init);
        },
      });

      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.url.includes('/memory/write'))).toBe(true);
      expect(calls.every((call) => call.method === 'POST')).toBe(true);
      expect(result).toEqual(expect.objectContaining({
        imported: 2,
        updated: 0,
        skipped: 0,
        errors: 0,
      }));
      expect(queryMemoryCount(daemon.db, ['first-entry', 'second-entry'])).toBe(2);
    } finally {
      daemon.stop();
    }
  });

  test('apply is idempotent by slug across repeated runs', async () => {
    const daemon = setupMemoryDaemon();
    try {
      writeMemoryFile('only.md', ccFile('single-entry', {
        description: 'Idempotent',
        type: 'feedback',
        body: 'Body',
      }));

      const first = await runMemoryImport({
        root,
        dryRun: false,
        apply: true,
        storageRoot: daemon.storageRoot,
        fetch: daemon.fetch,
      });
      expect(first.imported).toBe(1);
      expect(first.updated).toBe(0);
      expect(first.errors).toBe(0);

      const second = await runMemoryImport({
        root,
        dryRun: false,
        apply: true,
        storageRoot: daemon.storageRoot,
        fetch: daemon.fetch,
      });
      expect(second.imported).toBe(0);
      expect(second.updated).toBe(1);
      expect(second.errors).toBe(0);

      expect(queryMemoryCount(daemon.db, ['single-entry'])).toBe(1);
    } finally {
      daemon.stop();
    }
  });

  test('apply creates backlink rows for wiki links in imported bodies', async () => {
    const daemon = setupMemoryDaemon();
    try {
      writeMemoryFile('a.md', ccFile('a-links-b', {
        description: 'A memory',
        type: 'feedback',
        body: 'This references [[b-entry]].',
      }));
      writeMemoryFile('b.md', ccFile('b-entry', {
        description: 'B memory',
        type: 'feedback',
        body: 'The target of a link.',
      }));

      const result = await runMemoryImport({
        root,
        dryRun: false,
        apply: true,
        storageRoot: daemon.storageRoot,
        fetch: daemon.fetch,
      });

      expect(result.errors).toBe(0);
      const links = parseLinksFromSlugRows(daemon.db, 'a-links-b');
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ raw_slug: 'b-entry' });
      expect(['wiki', 'wiki_unresolved']).toContain(links[0]!.link_type);
    } finally {
      daemon.stop();
    }
  });

  test('apply requires --root at CLI level', async () => {
    const cli = join(process.cwd(), 'packages/cli/bin/penumbra.ts');
    const proc = spawnSync('bun', [cli, 'memory', 'import-from-claude-code', '--apply'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(proc.status).not.toBe(0);
    expect(proc.stderr ?? '').toContain('usage: penumbra memory import-from-claude-code --root <path> (--dry-run | --apply)');
  });
});
