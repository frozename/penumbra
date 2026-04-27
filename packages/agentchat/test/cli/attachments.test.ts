import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAttachmentPreamble, parseAttachFlags } from '../../src/cli/attachments.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'attachments-'));
}

test('parseAttachFlags collects each --attach <path>, repeatable, in argv order', () => {
  const argv = ['bun', 'agentchat.ts', 'new', '--attach', 'a.md', '--auto', '--attach', 'b.md'];
  expect(parseAttachFlags(argv)).toEqual(['a.md', 'b.md']);
});

test('parseAttachFlags returns [] when no --attach is present', () => {
  expect(parseAttachFlags(['bun', 'agentchat.ts', 'new', '--auto'])).toEqual([]);
});

test('parseAttachFlags ignores --attach with no following argument', () => {
  expect(parseAttachFlags(['bun', 'agentchat.ts', 'new', '--attach'])).toEqual([]);
});

test('parseAttachFlags collects --attach=<path> value (supports hyphenated filenames)', () => {
  const argv = ['bun', 'agentchat.ts', 'new', '--attach=-file.txt'];
  expect(parseAttachFlags(argv)).toEqual(['-file.txt']);
});

test('parseAttachFlags collects --attach=<path> for a normal path', () => {
  const argv = ['bun', 'agentchat.ts', 'new', '--attach=path/to/normal.txt'];
  expect(parseAttachFlags(argv)).toEqual(['path/to/normal.txt']);
});

test('parseAttachFlags ignores hyphenated next token in space-form (safety for flags)', () => {
  const argv = ['bun', 'agentchat.ts', 'new', '--attach', '--auto'];
  expect(parseAttachFlags(argv)).toEqual([]);
});

test('buildAttachmentPreamble: empty list -> empty string', () => {
  expect(buildAttachmentPreamble([])).toBe('');
});

test('buildAttachmentPreamble: single file produces the webui --- File header template', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'note.md'), 'hello world\n');
    const out = buildAttachmentPreamble([join(dir, 'note.md')]);
    expect(out).toBe('\n\n--- File: note.md ---\nhello world\n\n\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildAttachmentPreamble: multiple files concatenate, each with its own header, in argv order', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.md'), 'AAA');
    writeFileSync(join(dir, 'b.md'), 'BBB');
    const out = buildAttachmentPreamble([join(dir, 'a.md'), join(dir, 'b.md')]);
    expect(out).toBe('\n\n--- File: a.md ---\nAAA\n\n--- File: b.md ---\nBBB\n\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildAttachmentPreamble: missing file throws with the path in the message', () => {
  expect(() => buildAttachmentPreamble(['/tmp/definitely-not-a-real-file-zzz.md']))
    .toThrow(/definitely-not-a-real-file-zzz\.md/);
});

test('buildAttachmentPreamble: uses basename, not full path, in the header', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'subdir');
    writeFileSync(join(dir, 'leaf.txt'), 'X');
    const out = buildAttachmentPreamble([join(dir, 'leaf.txt')]);
    expect(out).toContain('--- File: leaf.txt ---');
    expect(out).not.toContain(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
