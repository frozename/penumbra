import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeGlob, executeGrep } from '../src/fs-search.js';

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

  it('honors nested .gitignore files', async () => {
    fs.mkdirSync(path.join(tmp, 'subdir'));
    fs.writeFileSync(path.join(tmp, '.gitignore'), '*.log\n');
    fs.writeFileSync(path.join(tmp, 'kept.txt'), 'x');
    fs.writeFileSync(path.join(tmp, 'ignored.log'), 'y');
    fs.writeFileSync(path.join(tmp, 'subdir', '.gitignore'), '*.tmp\n');
    fs.writeFileSync(path.join(tmp, 'subdir', 'kept.txt'), 'z');
    fs.writeFileSync(path.join(tmp, 'subdir', 'ignored.tmp'), 'w');

    const r = await executeGlob({ pattern: '**/*' }, tmp);
    expect(r.results.sort()).toEqual(['kept.txt', 'subdir/kept.txt']);
  });

  it('respects negated patterns in .gitignore', async () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '*.log\n!important.log\n');
    fs.writeFileSync(path.join(tmp, 'important.log'), 'x');
    fs.writeFileSync(path.join(tmp, 'other.log'), 'y');

    const r = await executeGlob({ pattern: '*.log' }, tmp);
    expect(r.results).toEqual(['important.log']);
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

describe('executeGrep', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-grep-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.PENUMBRA_RG_BINARY;
  });

  it('content mode: returns {path, line, text} rows for each match', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'foo\nTODO bar\nbaz\n');
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'no match\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(r.results).toEqual([{ path: 'a.ts', line: 2, text: 'TODO bar' }]);
    expect(r.truncated).toBe(false);
  });

  it('respects glob filter', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'TODO\n');
    fs.writeFileSync(path.join(tmp, 'a.md'), 'TODO\n');
    const r = await executeGrep({ pattern: 'TODO', glob: '*.ts', output_mode: 'content' }, tmp);
    expect(r.results.map((x: any) => x.path)).toEqual(['a.ts']);
  });

  it('case_insensitive=true matches mixed case', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'todo lower\nTODO upper\n');
    const r = await executeGrep({ pattern: 'todo', case_insensitive: true, output_mode: 'content' }, tmp);
    expect(r.results.length).toBe(2);
  });

  it('truncates content mode at default 50 and sets truncated=true', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push('TODO line ' + i);
    fs.writeFileSync(path.join(tmp, 'big.ts'), lines.join('\n') + '\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(r.results.length).toBe(50);
    expect(r.truncated).toBe(true);
  });

  it('per-line text capped at 1KB with ellipsis suffix', async () => {
    const long = 'TODO ' + 'x'.repeat(2000);
    fs.writeFileSync(path.join(tmp, 'big.ts'), long + '\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(r.results[0].text.length).toBeLessThanOrEqual(1024);
    expect(r.results[0].text.endsWith('…')).toBe(true);
  });

  it('files_with_matches mode returns deduped paths', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'TODO\nTODO again\n');
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'no\n');
    const r = await executeGrep({ pattern: 'TODO', output_mode: 'files_with_matches' }, tmp);
    expect(r.results).toEqual(['a.ts']);
    expect(r.truncated).toBe(false);
  });

  it('returns engine_unavailable error when rg binary missing', async () => {
    process.env.PENUMBRA_RG_BINARY = '/nonexistent/rg';
    try {
      await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('engine_unavailable');
    }
  });

  it('returns bad_pattern error for an invalid regex', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'x\n');
    try {
      await executeGrep({ pattern: '[invalid', output_mode: 'content' }, tmp);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('bad_pattern');
    }
  });

  it('include_ignored=true passes --no-ignore to rg', async () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(tmp, 'ignored.ts'), 'TODO\n');
    fs.writeFileSync(path.join(tmp, 'kept.ts'), 'TODO\n');
    const without = await executeGrep({ pattern: 'TODO', output_mode: 'content' }, tmp);
    expect(without.results.map((x: any) => x.path).sort()).toEqual(['kept.ts']);
    const withIgnored = await executeGrep({ pattern: 'TODO', output_mode: 'content', include_ignored: true }, tmp);
    expect(withIgnored.results.map((x: any) => x.path).sort()).toEqual(['ignored.ts', 'kept.ts']);
  });
});
