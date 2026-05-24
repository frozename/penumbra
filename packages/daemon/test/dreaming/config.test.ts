import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { loadDreamConfigFromEnv } from '../../src/dreaming/config.js';

describe('dreaming/config', () => {
  let originalHours: string | undefined;
  let originalNegativeCacheTtlMs: string | undefined;

  beforeEach(() => {
    originalHours = process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    originalNegativeCacheTtlMs = process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS;
    delete process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    delete process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS;
  });

  afterEach(() => {
    if (originalHours === undefined) delete process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    else process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = originalHours;
    if (originalNegativeCacheTtlMs === undefined) delete process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS;
    else process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS = originalNegativeCacheTtlMs;
  });

  it('falls back to default for negative non-negative integers with warn', () => {
    process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = '-5';
    const warnSpy = spyOn(console, 'warn');
    const config = loadDreamConfigFromEnv();
    expect(config.briefRefreshHours).toBe(24);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('defaults negativeCacheTtlMs to 24h when env var is unset', () => {
    const config = loadDreamConfigFromEnv();
    expect(config.negativeCacheTtlMs).toBe(86_400_000);
  });

  it('uses the env override for negativeCacheTtlMs when provided', () => {
    process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS = '1000';
    const config = loadDreamConfigFromEnv();
    expect(config.negativeCacheTtlMs).toBe(1000);
  });
});
