import { describe, expect, it } from 'bun:test';
import { GoogleOtlpSynth } from '../../src/usage-readers/google-otlp-synth.js';
import type { QuotaStatusResponse } from '../../src/penumbra-client.js';

function makeResponse(rows: QuotaStatusResponse['providers']): QuotaStatusResponse {
  return {
    window: { from: '2026-05-08T00:00:00Z', to: '2026-05-08T01:00:00Z' },
    providers: rows,
  };
}

describe('GoogleOtlpSynth', () => {
  it('emits model-aware snapshots for daily and five_hour windows', async () => {
    const calls: Array<{ since?: string; window?: '24h' | '5h' }> = [];
    const client = {
      async fetchQuotaStatus(args?: { since?: string; window?: '24h' | '5h' }): Promise<QuotaStatusResponse> {
        calls.push(args ?? {});
        return makeResponse([
          {
            provider: 'google',
            model: 'gemini-3.1-pro-preview',
            used_usd: null,
            quota_usd: null,
            remaining_usd: null,
            remaining_pct_usd: null,
            used_tokens: 40,
            quota_tokens: 100,
            remaining_tokens: 60,
            remaining_pct_tokens: 60,
          },
          {
            provider: 'google',
            model: 'gemini-3-flash-preview',
            used_usd: null,
            quota_usd: null,
            remaining_usd: null,
            remaining_pct_usd: null,
            used_tokens: 50,
            quota_tokens: 200,
            remaining_tokens: 150,
            remaining_pct_tokens: 75,
          },
          {
            provider: 'openai',
            model: 'gpt-5',
            used_usd: null,
            quota_usd: null,
            remaining_usd: null,
            remaining_pct_usd: null,
            used_tokens: 999,
            quota_tokens: 1000,
            remaining_tokens: 1,
            remaining_pct_tokens: 0.1,
          },
        ]);
      },
    };

    const reader = new GoogleOtlpSynth({
      client,
      now: () => new Date('2026-05-08T12:34:30Z'),
    });

    const out = await reader.read(null);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.window).toBe('24h');
    expect(calls[1]?.window).toBe('5h');
    expect(out.usage_deltas).toHaveLength(0);
    expect(out.rate_limit_snapshots).toHaveLength(4);

    const daily = out.rate_limit_snapshots.filter((d) => d.window_label === 'daily');
    const fiveHour = out.rate_limit_snapshots.filter((d) => d.window_label === 'five_hour');
    expect(daily).toHaveLength(2);
    expect(fiveHour).toHaveLength(2);
    expect(daily.every((d) => d.window_minutes === 1440)).toBe(true);
    expect(fiveHour.every((d) => d.window_minutes === 300)).toBe(true);

    const proDaily = daily.find((d) => d.model === 'gemini-3.1-pro-preview');
    const flashDaily = daily.find((d) => d.model === 'gemini-3-flash-preview');
    expect(proDaily?.used_pct).toBe(40);
    expect(flashDaily?.used_pct).toBe(25);
  });

  it('skips rows below min_emit_pct and does not advance cursor for skipped emission', async () => {
    const now = new Date('2026-05-08T12:34:10Z');
    const minuteBucket = Math.floor(now.getTime() / (60 * 1000));
    const reader = new GoogleOtlpSynth({
      client: {
        async fetchQuotaStatus(args?: { since?: string; window?: '24h' | '5h' }): Promise<QuotaStatusResponse> {
          if (args?.window === '24h') {
            return makeResponse([
              {
                provider: 'google',
                model: 'gemini-3.1-pro-preview',
                used_usd: null,
                quota_usd: null,
                remaining_usd: null,
                remaining_pct_usd: null,
                used_tokens: 3,
                quota_tokens: 100,
                remaining_tokens: 97,
                remaining_pct_tokens: 97,
              },
            ]);
          }
          return makeResponse([
            {
              provider: 'google',
              model: 'gemini-3.1-pro-preview',
              used_usd: null,
              quota_usd: null,
              remaining_usd: null,
              remaining_pct_usd: null,
              used_tokens: 8,
              quota_tokens: 100,
              remaining_tokens: 92,
              remaining_pct_tokens: 92,
            },
          ]);
        },
      },
      now: () => now,
      min_emit_pct: 5,
    });

    const first = await reader.read(null);
    expect(first.rate_limit_snapshots).toHaveLength(1);
    expect(first.rate_limit_snapshots[0]?.window_label).toBe('five_hour');
    expect(first.rate_limit_snapshots[0]?.used_pct).toBe(8);
    expect(first.cursor).toEqual({
      last_emitted_minute: {
        'five_hour gemini-3.1-pro-preview': minuteBucket,
      },
    });

    const second = await reader.read(first.cursor);
    expect(second.rate_limit_snapshots).toHaveLength(0);
    expect(second.cursor).toEqual(first.cursor);
  });

  it('emits 0%-usage rows by default when min_emit_pct is omitted', async () => {
    const reader = new GoogleOtlpSynth({
      client: {
        async fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return makeResponse([
            {
              provider: 'google',
              model: 'gemini-3.1-pro-preview',
              used_usd: null,
              quota_usd: null,
              remaining_usd: null,
              remaining_pct_usd: null,
              used_tokens: 0,
              quota_tokens: 100,
              remaining_tokens: 100,
              remaining_pct_tokens: 100,
            },
          ]);
        },
      },
      now: () => new Date('2026-05-08T12:34:10Z'),
    });

    const out = await reader.read(null);
    expect(out.rate_limit_snapshots).toHaveLength(2);
    expect(out.rate_limit_snapshots.every((d) => d.used_pct === 0)).toBe(true);
  });

  it('dedupes emission within the same minute via cursor', async () => {
    const client = {
      async fetchQuotaStatus(): Promise<QuotaStatusResponse> {
        return makeResponse([
          {
            provider: 'google',
            model: 'gemini-3.1-pro-preview',
            used_usd: null,
            quota_usd: null,
            remaining_usd: null,
            remaining_pct_usd: null,
            used_tokens: 40,
            quota_tokens: 100,
            remaining_tokens: 60,
            remaining_pct_tokens: 60,
          },
        ]);
      },
    };

    const reader = new GoogleOtlpSynth({
      client,
      now: () => new Date('2026-05-08T12:34:10Z'),
    });

    const first = await reader.read(null);
    expect(first.rate_limit_snapshots).toHaveLength(2);

    const second = await reader.read(first.cursor);
    expect(second.rate_limit_snapshots).toHaveLength(0);
  });

  it('returns empty deltas when quota-status fetch fails', async () => {
    const reader = new GoogleOtlpSynth({
      client: {
        async fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          throw new Error('network down');
        },
      },
      now: () => new Date('2026-05-08T12:34:10Z'),
    });

    await expect(reader.read(null)).resolves.toEqual({
      cursor: { last_emitted_minute: {} },
      usage_deltas: [],
      rate_limit_snapshots: [],
    });
  });

  it('filters out non-google rows and rows without quota_tokens/model', async () => {
    const reader = new GoogleOtlpSynth({
      client: {
        async fetchQuotaStatus(): Promise<QuotaStatusResponse> {
          return makeResponse([
            {
              provider: 'google',
              model: undefined,
              used_usd: null,
              quota_usd: null,
              remaining_usd: null,
              remaining_pct_usd: null,
              used_tokens: 40,
              quota_tokens: 100,
              remaining_tokens: 60,
              remaining_pct_tokens: 60,
            },
            {
              provider: 'google',
              model: 'gemini-3.1-pro-preview',
              used_usd: null,
              quota_usd: null,
              remaining_usd: null,
              remaining_pct_usd: null,
              used_tokens: 40,
              quota_tokens: null,
              remaining_tokens: null,
              remaining_pct_tokens: null,
            },
            {
              provider: 'openai',
              model: 'gpt-5',
              used_usd: null,
              quota_usd: null,
              remaining_usd: null,
              remaining_pct_usd: null,
              used_tokens: 40,
              quota_tokens: 100,
              remaining_tokens: 60,
              remaining_pct_tokens: 60,
            },
          ]);
        },
      },
      now: () => new Date('2026-05-08T12:34:10Z'),
    });

    const out = await reader.read(null);
    expect(out.rate_limit_snapshots).toHaveLength(0);
  });
});
