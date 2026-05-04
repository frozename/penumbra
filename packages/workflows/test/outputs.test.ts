import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitFileOutput } from '../src/outputs/file.js';
import { emitNextSessionPromptOutput } from '../src/outputs/next-session-prompt.js';

test('emitFileOutput writes path with body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'out-'));
  try {
    const target = join(dir, 'subdir', 'out.md');
    const r = await emitFileOutput({ path: target, body: 'hello\n' });
    expect(r.warnings).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emitFileOutput on unwritable parent returns warning', async () => {
  const r = await emitFileOutput({ path: '/dev/null/cannot-write/here.md', body: 'x' });
  expect(r.warnings.length).toBeGreaterThan(0);
});

test('emitNextSessionPromptOutput writes to ~/.penumbra/pending-handoff.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'penum-'));
  try {
    const r = await emitNextSessionPromptOutput({ body: 'next prompt body', storageRoot: dir });
    const target = join(dir, 'pending-handoff.md');
    expect(r.warnings).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('next prompt body');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
