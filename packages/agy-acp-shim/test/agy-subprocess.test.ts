import { describe, expect, it } from 'bun:test';
import { spawnAgy } from '../src/agy-subprocess.js';

describe('spawnAgy', () => {
  it('yields lines from a mock echo process', async () => {
    const lines: string[] = [];
    const proc = spawnAgy({
      binary: 'echo',
      args: ['hello world'],
      onLine: (l) => lines.push(l),
    });
    await proc.exited;
    expect(lines.join(' ').trim()).toContain('hello world');
  });

  it('writes the prompt to stdin when provided', async () => {
    const lines: string[] = [];
    const proc = spawnAgy({
      binary: 'cat',
      args: [],
      prompt: 'first line\nsecond line',
      onLine: (l) => lines.push(l),
    });
    await proc.exited;
    expect(lines.join('\n')).toContain('first line');
    expect(lines.join('\n')).toContain('second line');
  });

  it('kill() terminates the subprocess before natural exit', async () => {
    const proc = spawnAgy({ binary: 'sleep', args: ['60'], onLine: () => {} });
    proc.kill();
    const code = await proc.exited;
    // SIGTERM exits non-zero on macOS
    expect(code).not.toBe(0);
  });

  it('resolves exited after process finishes', async () => {
    const proc = spawnAgy({ binary: 'true', args: [], onLine: () => {} });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
