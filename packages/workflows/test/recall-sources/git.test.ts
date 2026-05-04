import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runGitLog, runGitDiff } from '../../src/recall-sources/git.js';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'git-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  execSync('git add a.txt && git commit -q -m "first commit"', { cwd: dir, shell: '/bin/bash' });
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  execSync('git add a.txt && git commit -q -m "second commit"', { cwd: dir, shell: '/bin/bash' });
  return dir;
}

test('git.log returns commit log lines', async () => {
  const dir = initRepo();
  try {
    const out = await runGitLog({ cwd: dir, args: { range: 'HEAD~1..HEAD' } });
    expect(out.text).toContain('second commit');
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git.diff returns unified diff', async () => {
  const dir = initRepo();
  try {
    const out = await runGitDiff({ cwd: dir, args: { range: 'HEAD~1..HEAD' } });
    expect(out.text).toContain('+two');
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git.log on bad range returns warning, not throw', async () => {
  const dir = initRepo();
  try {
    const out = await runGitLog({ cwd: dir, args: { range: 'no-such-ref' } });
    expect(out.text).toBe('');
    expect(out.warnings.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
