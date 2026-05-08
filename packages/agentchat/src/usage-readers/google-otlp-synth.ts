import type { QuotaStatusResponse } from '../penumbra-client.js';
import type { RateLimitDelta, UsageReader, UsageReaderResult } from './index.js';

const DAILY_MS = 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

interface GoogleOtlpSynthCursor {
  last_emitted_minute: Record<string, number>;
}

export interface GoogleOtlpSynthOptions {
  client: { fetchQuotaStatus(args?: { since?: string }): Promise<QuotaStatusResponse> };
  now?: () => Date;
}

export class GoogleOtlpSynth implements UsageReader {
  readonly id = 'google-otlp-synth';
  private readonly client: GoogleOtlpSynthOptions['client'];
  private readonly now: () => Date;

  constructor(opts: GoogleOtlpSynthOptions) {
    this.client = opts.client;
    this.now = opts.now ?? (() => new Date());
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    const cursor = normalizeCursor(previousCursor);
    const now = this.now();
    const nowMs = now.getTime();
    const minuteBucket = Math.floor(nowMs / MINUTE_MS);
    const nextCursor: GoogleOtlpSynthCursor = {
      last_emitted_minute: { ...cursor.last_emitted_minute },
    };

    const snapshots: RateLimitDelta[] = [];
    for (const window of [
      { label: 'daily', ms: DAILY_MS, minutes: 1440 },
      { label: 'five_hour', ms: FIVE_HOUR_MS, minutes: 300 },
    ] as const) {
      let status: QuotaStatusResponse;
      try {
        status = await this.client.fetchQuotaStatus({ since: new Date(nowMs - window.ms).toISOString() });
      } catch {
        return {
          cursor,
          usage_deltas: [],
          rate_limit_snapshots: [],
        };
      }

      for (const row of status.providers) {
        if (row.provider !== 'google') continue;
        if (!row.model) continue;
        if (row.quota_tokens == null || row.used_tokens == null) continue;

        const used = Number(row.used_tokens);
        const quota = Number(row.quota_tokens);
        if (!Number.isFinite(used) || !Number.isFinite(quota) || quota <= 0) continue;

        const dedupeKey = `${window.label} ${row.model}`;
        if (nextCursor.last_emitted_minute[dedupeKey] === minuteBucket) continue;

        snapshots.push({
          provider: 'google',
          model: row.model,
          window_label: window.label,
          used_pct: clampPct((used / quota) * 100),
          window_minutes: window.minutes,
        });
        nextCursor.last_emitted_minute[dedupeKey] = minuteBucket;
      }
    }

    return {
      cursor: nextCursor,
      usage_deltas: [],
      rate_limit_snapshots: snapshots,
    };
  }
}

function normalizeCursor(cursor: unknown | null): GoogleOtlpSynthCursor {
  if (!cursor || typeof cursor !== 'object') {
    return { last_emitted_minute: {} };
  }

  const candidate = (cursor as { last_emitted_minute?: unknown }).last_emitted_minute;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { last_emitted_minute: {} };
  }

  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      cleaned[k] = v;
    }
  }
  return { last_emitted_minute: cleaned };
}

function clampPct(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
