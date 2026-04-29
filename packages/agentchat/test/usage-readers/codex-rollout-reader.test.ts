import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutReader } from '../../src/usage-readers/codex-rollout-reader.js';

function writeRollout(dir: string, name: string, lines: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const tokenCountLine = (used_pct_primary: number, used_pct_secondary: number, resets_p = 1777364441, resets_s = 1777545224) => ({
  type: 'event_msg',
  timestamp: '2026-04-28T12:00:00Z',
  payload: {
    type: 'token_count',
    rate_limits: {
      limit_id: 'codex',
      primary:   { used_percent: used_pct_primary,   window_minutes: 300,   resets_at: resets_p },
      secondary: { used_percent: used_pct_secondary, window_minutes: 10080, resets_at: resets_s },
      plan_type: 'plus',
      rate_limit_reached_type: null,
    },
  },
});

describe('CodexRolloutReader', () => {
  it('emits one rate-limit-snapshot per window from the latest token_count event', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, 'rollout-2026-04-28T12-00-00-aaa.jsonl', [
      tokenCountLine(2.0, 30.0),
      tokenCountLine(3.0, 31.0),
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const result = await reader.read(null);
    expect(result.rate_limit_snapshots).toHaveLength(2);
    const primary = result.rate_limit_snapshots.find(s => s.window_label === 'primary');
    expect(primary?.used_pct).toBe(3.0);
    expect(primary?.window_minutes).toBe(300);
  });

  it('cursor persists byte_offset; second read with same file emits no new snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, 'rollout-2026-04-28T12-00-00-bbb.jsonl', [tokenCountLine(5.0, 40.0)]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r1 = await reader.read(null);
    expect(r1.rate_limit_snapshots).toHaveLength(2);
    const r2 = await reader.read(r1.cursor);
    expect(r2.rate_limit_snapshots).toHaveLength(0);
  });

  it('canonicalizes provider name to "openai"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, 'rollout-2026-04-28T12-00-00-ccc.jsonl', [tokenCountLine(1.0, 1.0)]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots.every(s => s.provider === 'openai')).toBe(true);
  });

  it('skips corrupt lines, continues parsing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, 'rollout-2026-04-28T12-00-00-ddd.jsonl');
    writeFileSync(path, [
      '{not valid json',
      JSON.stringify(tokenCountLine(7.0, 70.0)),
    ].join('\n') + '\n');
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    expect(r.rate_limit_snapshots.find(s => s.window_label === 'primary')?.used_pct).toBe(7.0);
  });

  it('returns empty result when root dir is absent', async () => {
    const reader = new CodexRolloutReader({ rootDir: '/tmp/this-does-not-exist-xyz' });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(0);
    expect(r.usage_deltas).toHaveLength(0);
  });
});
