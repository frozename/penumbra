import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeJsonlReader } from '../../src/usage-readers/claude-jsonl-reader.js';

function setupProjectsDir(): { rootDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-projects-'));
  return { rootDir: root };
}

function writeJsonl(rootDir: string, project: string, sessionId: string, lines: object[]): string {
  const projDir = join(rootDir, project);
  mkdirSync(projDir, { recursive: true });
  const path = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('ClaudeJsonlReader', () => {
  it('aggregates input + output tokens by model from assistant rows', async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, '-Volumes-WorkSSD-foo', 'sess-1', [
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].provider).toBe('anthropic');
    expect(r.usage_deltas[0].model).toBe('claude-opus-4-7');
    expect(r.usage_deltas[0].tokens_input).toBe(40);
    expect(r.usage_deltas[0].tokens_output).toBe(60);
    expect(r.usage_deltas[0].tokens_cache_read).toBe(15);
    expect(r.usage_deltas[0].tokens_cache_write).toBe(2);
    expect(r.usage_deltas[0].cost_usd).toBeNull();
  });

  it('cursor advances by file byte_offset; second call returns nothing for same content', async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, '-foo', 'sess', [
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r1 = await reader.read(null);
    expect(r1.usage_deltas).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.usage_deltas).toHaveLength(0);
  });

  it('skips non-assistant lines and rows without usage', async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, '-bar', 'sess', [
      { type: 'queue-operation', timestamp: '2026-04-28T12:00:00Z' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { model: 'claude-opus-4-7' } },
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].tokens_input).toBe(1);
  });
});
