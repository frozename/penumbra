import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveInsideWorktree, FsPathError } from '../src/fs-paths.js';

describe('resolveInsideWorktree', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-paths-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves an absolute path inside the worktree to its realpath', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const real = await resolveInsideWorktree(path.join(tmp, 'a.txt'), tmp);
    expect(real).toBe(fs.realpathSync(path.join(tmp, 'a.txt')));
  });

  it('rejects an absolute path outside the worktree', async () => {
    await expect(resolveInsideWorktree('/etc/passwd', tmp)).rejects.toThrow(FsPathError);
    try {
      await resolveInsideWorktree('/etc/passwd', tmp);
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe('outside_worktree');
    }
  });

  it('rejects a missing relative-with-.. path as outside_worktree (security-first)', async () => {
    // Even when the leaf doesn't exist, a path whose textual form escapes the
    // worktree should be flagged as outside_worktree, not not_found. The helper
    // realpaths the parent dir to keep canonical platform translation working
    // (e.g. macOS /var -> /private/var) without losing escape detection.
    const escape = path.join(tmp, '..', 'something.txt');
    await expect(resolveInsideWorktree(escape, tmp)).rejects.toMatchObject({ code: 'outside_worktree' });
  });

  it('rejects a symlink whose realpath is outside the worktree', async () => {
    fs.writeFileSync('/tmp/fs-paths-target.txt', 'secret');
    fs.symlinkSync('/tmp/fs-paths-target.txt', path.join(tmp, 'link'));
    try {
      await resolveInsideWorktree(path.join(tmp, 'link'), tmp);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe('outside_worktree');
    } finally {
      fs.unlinkSync('/tmp/fs-paths-target.txt');
    }
  });

  it('accepts a path already inside a symlinked worktree after realpath resolution', async () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-paths-real-'));
    const symlinkRoot = path.join(tmp, 'alias');
    fs.symlinkSync(realRoot, symlinkRoot);
    fs.mkdirSync(path.join(realRoot, 'nested'));
    fs.writeFileSync(path.join(realRoot, 'nested', 'file.txt'), 'x');

    const resolved = await resolveInsideWorktree(path.join(realRoot, 'nested', 'file.txt'), symlinkRoot);
    expect(resolved).toBe(fs.realpathSync(path.join(realRoot, 'nested', 'file.txt')));
  });

  it('throws FsPathError with code "not_found" for missing path', async () => {
    try {
      await resolveInsideWorktree(path.join(tmp, 'nope.txt'), tmp);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathError);
      expect((err as FsPathError).code).toBe('not_found');
    }
  });
});
