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

  // Snapshot test against a verbatim payload captured from a production codex
  // rollout file (~/.codex/sessions/2026/03/28/...) on 2026-05-08. Locks the
  // reader against upstream Codex schema drift in the rate_limits shape.
  it('parses a verbatim production rate_limits payload (codex-acp 2026-03-28)', async () => {
    const productionLine = {
      timestamp: '2026-03-28T11:25:38.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
        rate_limits: {
          limit_id: 'codex',
          limit_name: null,
          primary: { used_percent: 0.0, window_minutes: 300, resets_at: 1774725970 },
          secondary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1775312770 },
          credits: null,
          plan_type: 'plus',
        },
      },
    };
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '03', '28');
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, 'rollout-2026-03-28T11-25-38-prod-snapshot.jsonl', [productionLine]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    const primary = r.rate_limit_snapshots.find((s) => s.window_label === 'primary');
    expect(primary).toBeDefined();
    expect(primary?.provider).toBe('openai');
    expect(primary?.used_pct).toBe(0.0);
    expect(primary?.window_minutes).toBe(300);
    expect(primary?.resets_at).toBe(1774725970);
    expect(primary?.extra).toMatchObject({ plan_type: 'plus', limit_id: 'codex' });
    const secondary = r.rate_limit_snapshots.find((s) => s.window_label === 'secondary');
    expect(secondary?.window_minutes).toBe(10080);
  });
});
