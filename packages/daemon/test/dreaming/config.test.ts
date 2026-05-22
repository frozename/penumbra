import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { loadDreamConfigFromEnv } from '../../src/dreaming/config.js';

describe('dreaming/config', () => {
  let originalHours: string | undefined;

  beforeEach(() => {
    originalHours = process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
  });

  afterEach(() => {
    if (originalHours === undefined) delete process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS;
    else process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = originalHours;
  });

  it('falls back to default for negative non-negative integers with warn', () => {
    process.env.PENUMBRA_DREAMING_BRIEF_REFRESH_HOURS = '-5';
    const warnSpy = spyOn(console, 'warn');
    const config = loadDreamConfigFromEnv();
    expect(config.briefRefreshHours).toBe(24);
    expect(warnSpy).toHaveBeenCalled();
  });
});
