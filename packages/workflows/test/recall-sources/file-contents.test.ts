import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFileContents } from '../../src/recall-sources/file-contents.js';

test('file.contents returns text body when file exists and fits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-contents-'));
  const relPath = 'notes.txt';
  const absPath = join(dir, relPath);
  writeFileSync(absPath, 'hello workflow recall\n');
  try {
    const out = await runFileContents({ cwd: dir, args: { path: relPath } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe('hello workflow recall\n');
    expect(out.result.truncated).toBe(false);
    expect(out.result.byte_size).toBe(Buffer.byteLength('hello workflow recall\n'));
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file.contents truncates body at max_bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-contents-'));
  const relPath = 'big.txt';
  const absPath = join(dir, relPath);
  writeFileSync(absPath, 'abcdefghij');
  try {
    const out = await runFileContents({ cwd: dir, args: { path: relPath, max_bytes: 4 } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe('abcd');
    expect(out.result.truncated).toBe(true);
    expect(out.result.byte_size).toBe(10);
    expect(out.warnings.length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file.contents returns not_found error for missing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-contents-'));
  try {
    const out = await runFileContents({ cwd: dir, args: { path: 'missing.txt' } });
    expect(out.result.path).toBe(join(dir, 'missing.txt'));
    expect(out.result.body).toBeNull();
    expect(out.result.error).toBe('not_found');
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file.contents returns not_found when path is empty (workflow opt-out)', async () => {
  const out = await runFileContents({ cwd: '/tmp', args: { path: '' } });
  expect(out.result.body).toBeNull();
  expect(out.result.error).toBe('not_found');
  expect(out.warnings).toEqual([]);
});

test('file.contents returns not_found when path resolves to a directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-contents-'));
  try {
    const out = await runFileContents({ cwd: dir, args: { path: '.' } });
    expect(out.result.body).toBeNull();
    expect(out.result.error).toBe('not_found');
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file.contents marks binary files with placeholder body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-contents-'));
  const relPath = 'data.bin';
  const absPath = join(dir, relPath);
  writeFileSync(absPath, Buffer.from([0x00, 0xff, 0x01, 0x02, 0x03]));
  try {
    const out = await runFileContents({ cwd: dir, args: { path: relPath } });
    expect(out.result.path).toBe(absPath);
    expect(out.result.body).toBe('<binary file omitted>');
    expect(out.result.truncated).toBe(false);
    expect(out.result.byte_size).toBe(5);
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
