import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { runMemoryImport } from '../../src/commands/memory.js';

let root = '';
let db: Database;

function ccFile(name: string, options: { description: string; type: string; body: string }): string {
  return `---\nname: ${name}\ndescription: ${options.description}\nmetadata:\n  type: ${options.type}\n---\n\n${options.body}`;
}

function writeMemoryFile(file: string, content: string): void {
  writeFileSync(join(root, file), content);
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
});

describe('runMemoryImport', () => {
  test('dry-run parses frontmatter and reports counts for valid files', () => {
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

    const result = runMemoryImport({ root, dryRun: true, print: (line) => { printed += line; } });
    expect(result).toEqual(expect.objectContaining({ would_write: 3, skipped: 0, errors: 0 }));
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.status === 'would_write')).toBe(true);
    expect(printed).toContain('WRITE first.md');
  });

  test('dry-run does not write rows to t2_memories', () => {
    writeMemoryFile('keep-same.md', ccFile('keep-same', {
      description: 'Will not be written during dry-run',
      type: 'reference',
      body: 'This memory stays unwritten in dry-run mode.',
    }));

    const before = (db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM t2_memories').get() as { count: number }).count;
    const result = runMemoryImport({ root, dryRun: true, db });
    const after = (db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM t2_memories').get() as { count: number }).count;

    expect(result.would_write).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.skipped).toBe(0);
    expect(after).toBe(before);
  });

  test('skip files without frontmatter', () => {
    writeMemoryFile('foo.md', 'This file is missing frontmatter and should be skipped.');
    const result = runMemoryImport({ root, dryRun: true });

    expect(result.would_write).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ file: 'foo.md', status: 'skipped', reason: 'no_frontmatter' });
  });

  test('reject invalid cc_kind values', () => {
    writeMemoryFile('invalid.md', ccFile('invalid-kind', {
      description: 'Bad kind',
      type: 'invalid-kind',
      body: 'This has an invalid metadata type.',
    }));

    const result = runMemoryImport({ root, dryRun: true });

    expect(result.would_write).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ file: 'invalid.md', status: 'error', reason: 'unknown_cc_kind' });
  });

  test('extract [[backlink]] references from body', () => {
    writeMemoryFile('links.md', ccFile('link-memory', {
      description: 'Has a backlink',
      type: 'feedback',
      body: 'This memory links to [[some-other-slug]] and [[another-slug]].',
    }));

    const result = runMemoryImport({ root, dryRun: true });
    const row = result.rows[0];

    expect(row?.status).toBe('would_write');
    expect(row?.wiki_links).toEqual(['some-other-slug', 'another-slug']);
  });

  test('frontmatter maps to expected row shape', () => {
    writeMemoryFile('map.md', ccFile('feedback-dispatch-must-pin-event-bus-types', {
      description: 'When a dispatch needs to subscribe to events...',
      type: 'feedback',
      body: 'body-body-body markdown',
    }));

    const result = runMemoryImport({ root, dryRun: true });
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

  test('invalid root fails with root_not_found and does not run', () => {
    const result = runMemoryImport({ root: '/non/existent/path', dryRun: true });
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
});
