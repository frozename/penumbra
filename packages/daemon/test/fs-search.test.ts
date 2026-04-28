import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeGlob } from '../src/fs-search.js';

describe('executeGlob', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-glob-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns paths matching a simple pattern, relative to worktree', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'b.md'), 'y');
    const r = await executeGlob({ pattern: '*.ts' }, tmp);
    expect(r.results).toEqual(['a.ts']);
    expect(r.truncated).toBe(false);
  });

  it('matches recursive ** patterns', async () => {
    fs.mkdirSync(path.join(tmp, 'nested'));
    fs.writeFileSync(path.join(tmp, 'nested/c.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'd.ts'), 'y');
    const r = await executeGlob({ pattern: '**/*.ts' }, tmp);
    expect(r.results.sort()).toEqual(['d.ts', 'nested/c.ts']);
  });

  it('sorts results by mtime descending', async () => {
    fs.writeFileSync(path.join(tmp, 'old.ts'), 'x');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmp, 'old.ts'), oldTime, oldTime);
    fs.writeFileSync(path.join(tmp, 'new.ts'), 'y');
    const r = await executeGlob({ pattern: '*.ts' }, tmp);
    expect(r.results).toEqual(['new.ts', 'old.ts']);
  });

  it('honors .gitignore by default', async () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tmp, 'kept.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'ignored.ts'), 'y');
    const r = await executeGlob({ pattern: '*.ts' }, tmp);
    expect(r.results).toEqual(['kept.ts']);
  });

  it('include_ignored=true overrides .gitignore', async () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tmp, 'kept.ts'), 'x');
    fs.writeFileSync(path.join(tmp, 'ignored.ts'), 'y');
    const r = await executeGlob({ pattern: '*.ts', include_ignored: true }, tmp);
    expect(r.results.sort()).toEqual(['ignored.ts', 'kept.ts']);
  });

  it('caps at default 1000 and sets truncated=true when more matches exist', async () => {
    for (let i = 0; i < 1005; i++) {
      fs.writeFileSync(path.join(tmp, `f${i}.txt`), 'x');
    }
    const r = await executeGlob({ pattern: '*.txt' }, tmp);
    expect(r.results.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('respects a smaller max_results override', async () => {
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(tmp, `f${i}.txt`), 'x');
    }
    const r = await executeGlob({ pattern: '*.txt', max_results: 10 }, tmp);
    expect(r.results.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('skips broken symlinks silently', async () => {
    fs.symlinkSync('/nonexistent/path', path.join(tmp, 'broken'));
    fs.writeFileSync(path.join(tmp, 'real.txt'), 'x');
    const r = await executeGlob({ pattern: '*' }, tmp);
    expect(r.results).toContain('real.txt');
  });

  it('returns empty results for non-matching pattern', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x');
    const r = await executeGlob({ pattern: '*.py' }, tmp);
    expect(r.results).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
