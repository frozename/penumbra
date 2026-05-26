import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getConfig, resetConfigForTest } from '@penumbra/config';
import { buildDreamingConfig } from '../../src/dreaming/config.js';

function buildFromProcessEnv(): ReturnType<typeof buildDreamingConfig> {
  resetConfigForTest();
  return buildDreamingConfig(getConfig(process.env));
}

describe('dreaming/config', () => {
  let originalHours: string | undefined;
  let originalNegativeCacheTtlMs: string | undefined;
  let originalRewriterEnabled: string | undefined;
  let originalRewriterBaseUrl: string | undefined;
  let originalRewriterModel: string | undefined;
  let originalRewriterTimeoutMs: string | undefined;
  let originalRewriterCacheTtlMs: string | undefined;
  let originalRewriterConcurrency: string | undefined;

  beforeEach(() => {
    resetConfigForTest();
    originalHours = process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    originalNegativeCacheTtlMs = process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS;
    originalRewriterEnabled = process.env.PENUMBRA_DREAMING_REWRITER_ENABLED;
    originalRewriterBaseUrl = process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL;
    originalRewriterModel = process.env.PENUMBRA_DREAMING_REWRITER_MODEL;
    originalRewriterTimeoutMs = process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS;
    originalRewriterCacheTtlMs = process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS;
    originalRewriterConcurrency = process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY;

    delete process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    delete process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS;
    delete process.env.PENUMBRA_DREAMING_REWRITER_ENABLED;
    delete process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL;
    delete process.env.PENUMBRA_DREAMING_REWRITER_MODEL;
    delete process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS;
    delete process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS;
    delete process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY;
  });

  afterEach(() => {
    if (originalHours === undefined) delete process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    else process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = originalHours;
    if (originalNegativeCacheTtlMs === undefined) delete process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS;
    else process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS = originalNegativeCacheTtlMs;
    if (originalRewriterEnabled === undefined) delete process.env.PENUMBRA_DREAMING_REWRITER_ENABLED;
    else process.env.PENUMBRA_DREAMING_REWRITER_ENABLED = originalRewriterEnabled;
    if (originalRewriterBaseUrl === undefined) delete process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL;
    else process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL = originalRewriterBaseUrl;
    if (originalRewriterModel === undefined) delete process.env.PENUMBRA_DREAMING_REWRITER_MODEL;
    else process.env.PENUMBRA_DREAMING_REWRITER_MODEL = originalRewriterModel;
    if (originalRewriterTimeoutMs === undefined) delete process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS;
    else process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS = originalRewriterTimeoutMs;
    if (originalRewriterCacheTtlMs === undefined) delete process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS;
    else process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS = originalRewriterCacheTtlMs;
    if (originalRewriterConcurrency === undefined) delete process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY;
    else process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY = originalRewriterConcurrency;
  });

  it('rejects negative integers at parse time (strict zod schema)', () => {
    process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = '-5';
    expect(() => buildFromProcessEnv()).toThrow(/PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS/);
  });

  it('defaults negativeCacheTtlMs to 24h when env var is unset', () => {
    const config = buildDreamingConfig(getConfig(process.env));
    expect(config.negativeCacheTtlMs).toBe(86_400_000);
  });

  it('uses the env override for negativeCacheTtlMs when provided', () => {
    process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS = '1000';
    const config = buildDreamingConfig(getConfig(process.env));
    expect(config.negativeCacheTtlMs).toBe(1000);
  });

  it('uses defaults for all new rewriter settings when env is unset', () => {
    const config = buildDreamingConfig(getConfig(process.env));
    expect(config.rewriterEnabled).toBe(false);
    expect(config.rewriterBaseUrl).toBe('http://127.0.0.1:7944');
    expect(config.rewriterModel).toBe('Qwen3.6-35B-A3B-4bit');
    expect(config.rewriterTimeoutMs).toBe(5000);
    expect(config.rewriterCacheTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(config.rewriterConcurrency).toBe(4);
  });

  it('overrides new rewriter settings via env when provided', () => {
    process.env.PENUMBRA_DREAMING_REWRITER_ENABLED = '1';
    process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL = 'http://127.0.0.1:9000';
    process.env.PENUMBRA_DREAMING_REWRITER_MODEL = 'qwen';
    process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS = '1234';
    process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS = '4567';
    process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY = '7';
    const config = buildDreamingConfig(getConfig(process.env));

    expect(config.rewriterEnabled).toBe(true);
    expect(config.rewriterBaseUrl).toBe('http://127.0.0.1:9000');
    expect(config.rewriterModel).toBe('qwen');
    expect(config.rewriterTimeoutMs).toBe(1234);
    expect(config.rewriterCacheTtlMs).toBe(4567);
    expect(config.rewriterConcurrency).toBe(7);
  });

  it('produces expected defaults and reads explicit env via config bundle', () => {
    const defaults = buildDreamingConfig(getConfig({}));
    expect(defaults.enabled).toBe(false);
    expect(defaults.briefRefreshHours).toBe(24);
    expect(defaults.rewriterModel).toBe('Qwen3.6-35B-A3B-4bit');

    const overrides = buildDreamingConfig(
      getConfig({ PENUMBRA_DREAMING_ENABLED: 'true', PENUMBRA_DREAMING_DAILY_USD: '5' })
    );
    expect(overrides.enabled).toBe(true);
    expect(overrides.dailyUsd).toBe(5);
  });
});
