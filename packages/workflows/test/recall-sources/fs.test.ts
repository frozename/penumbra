import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFsGlob } from '../../src/recall-sources/fs.js';

test('fs.glob lists files matching a pattern', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsg-'));
  try {
    mkdirSync(join(dir, 'docs/superpowers/specs'), { recursive: true });
    writeFileSync(join(dir, 'docs/superpowers/specs/a.md'), 'a');
    writeFileSync(join(dir, 'docs/superpowers/specs/b.md'), 'b');
    const out = await runFsGlob({ cwd: dir, args: { pattern: 'docs/superpowers/specs/*.md' } });
    expect(out.matches.sort()).toEqual(['docs/superpowers/specs/a.md', 'docs/superpowers/specs/b.md']);
    expect(out.warnings).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fs.glob with no matches returns empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsg-'));
  try {
    const out = await runFsGlob({ cwd: dir, args: { pattern: 'nope/*.x' } });
    expect(out.matches).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
