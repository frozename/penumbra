import { getConfig, resetConfigForTest } from "@penumbra/config";
import { buildDreamingConfig } from "@src/dreaming/config.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

function buildFromProcessEnv(): ReturnType<typeof buildDreamingConfig> {
  resetConfigForTest();
  return buildDreamingConfig(getConfig(process.env));
}

interface EnvSlot {
  read: () => string | undefined;
  write: (value: string) => void;
  clear: () => void;
}

const MANAGED_ENV: readonly EnvSlot[] = [
  {
    read: () => process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_REWRITER_ENABLED,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_REWRITER_ENABLED = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_REWRITER_ENABLED;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_REWRITER_MODEL,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_REWRITER_MODEL = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_REWRITER_MODEL;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_ENABLED,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_ENABLED = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_ENABLED;
    },
  },
  {
    read: () => process.env.PENUMBRA_DREAMING_DAILY_USD,
    write: (v): void => {
      process.env.PENUMBRA_DREAMING_DAILY_USD = v;
    },
    clear: (): void => {
      delete process.env.PENUMBRA_DREAMING_DAILY_USD;
    },
  },
];

describe("dreaming/config", () => {
  const saved = new Array<string | undefined>(MANAGED_ENV.length);

  beforeEach(() => {
    resetConfigForTest();
    for (const [i, slot] of MANAGED_ENV.entries()) {
      saved[i] = slot.read();
      slot.clear();
    }
  });

  afterEach(() => {
    for (const [i, slot] of MANAGED_ENV.entries()) {
      const prior = saved[i];
      if (prior === undefined) slot.clear();
      else slot.write(prior);
    }
  });

  it("rejects negative integers at parse time (strict zod schema)", () => {
    process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = "-5";
    expect(() => buildFromProcessEnv()).toThrow(/PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS/);
  });

  it("defaults negativeCacheTtlMs to 24h when env var is unset", () => {
    const config = buildDreamingConfig(getConfig(process.env));
    expect(config.negativeCacheTtlMs).toBe(86_400_000);
  });

  it("uses the env override for negativeCacheTtlMs when provided", () => {
    process.env.PENUMBRA_DREAMING_NEGATIVE_CACHE_TTL_MS = "1000";
    const config = buildDreamingConfig(getConfig(process.env));
    expect(config.negativeCacheTtlMs).toBe(1000);
  });

  it("uses defaults for all new rewriter settings when env is unset", () => {
    const config = buildDreamingConfig(getConfig(process.env));
    expect(config.rewriterEnabled).toBe(false);
    expect(config.rewriterBaseUrl).toBe("http://127.0.0.1:7944");
    expect(config.rewriterModel).toBe("granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf");
    expect(config.rewriterTimeoutMs).toBe(5000);
    expect(config.rewriterCacheTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(config.rewriterConcurrency).toBe(4);
  });

  it("overrides new rewriter settings via env when provided", () => {
    process.env.PENUMBRA_DREAMING_REWRITER_ENABLED = "1";
    process.env.PENUMBRA_DREAMING_REWRITER_BASE_URL = "http://127.0.0.1:9000";
    process.env.PENUMBRA_DREAMING_REWRITER_MODEL = "qwen";
    process.env.PENUMBRA_DREAMING_REWRITER_TIMEOUT_MS = "1234";
    process.env.PENUMBRA_DREAMING_REWRITER_CACHE_TTL_MS = "4567";
    process.env.PENUMBRA_DREAMING_REWRITER_CONCURRENCY = "7";
    const config = buildDreamingConfig(getConfig(process.env));

    expect(config.rewriterEnabled).toBe(true);
    expect(config.rewriterBaseUrl).toBe("http://127.0.0.1:9000");
    expect(config.rewriterModel).toBe("qwen");
    expect(config.rewriterTimeoutMs).toBe(1234);
    expect(config.rewriterCacheTtlMs).toBe(4567);
    expect(config.rewriterConcurrency).toBe(7);
  });

  it("produces expected defaults and reads explicit env via config bundle", () => {
    const defaults = buildDreamingConfig(getConfig({}));
    expect(defaults.enabled).toBe(false);
    expect(defaults.briefRefreshHours).toBe(24);
    expect(defaults.rewriterModel).toBe("granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf");
    expect(defaults.t2PromotionMinEvents).toBe(5);

    process.env.PENUMBRA_DREAMING_ENABLED = "true";
    process.env.PENUMBRA_DREAMING_DAILY_USD = "5";
    process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS = "7";
    const overrides = buildDreamingConfig(getConfig(process.env));
    expect(overrides.enabled).toBe(true);
    expect(overrides.dailyUsd).toBe(5);
    expect(overrides.t2PromotionMinEvents).toBe(7);
  });
});
