import { describe, expect, it } from 'bun:test';
import { checkPressureCap, type CheckPressureCapDeps, type PressureSnapshot } from '../../src/index.js';

const now = () => new Date('2026-05-08T01:00:00Z');

function makeSnapshot(overrides: Partial<PressureSnapshot> & Pick<PressureSnapshot, 'provider' | 'window_label' | 'used_pct' | 'observed_at'>): PressureSnapshot {
  return {
    provider: overrides.provider,
    window_label: overrides.window_label,
    used_pct: overrides.used_pct,
    observed_at: overrides.observed_at,
    resets_at: overrides.resets_at ?? null,
    source_kind: overrides.source_kind ?? 'statusline',
  };
}

function makeDeps(snapshotsByProvider: Record<string, PressureSnapshot[]>): CheckPressureCapDeps {
  return {
    cache: {
      forProvider(provider: string) {
        return snapshotsByProvider[provider] ?? [];
      },
    },
    agent: { name: 'agent', pricing_mode: 'subscription', subscription_provider: 'anthropic' },
    providerCaps: { anthropic: { five_hour: 90, seven_day: 90 } },
    now,
  };
}

describe('checkPressureCap', () => {
  it('pricing_mode: api → pass with pricing_mode_skip', () => {
    let called = false;
    const result = checkPressureCap({
      cache: {
        forProvider() {
          called = true;
          return [];
        },
      },
      agent: { name: 'agent', pricing_mode: 'api', subscription_provider: 'anthropic' },
      providerCaps: { anthropic: { five_hour: 90 } },
      now,
    });

    expect(called).toBe(false);
    expect(result).toEqual({ state: 'pass', snapshot_state: 'pricing_mode_skip' });
  });

  it('subscription agent without subscription_provider → pass with no_signal', () => {
    const result = checkPressureCap({
      cache: {
        forProvider() {
          throw new Error('should not be called');
        },
      },
      agent: { name: 'agent', pricing_mode: 'subscription' },
      providerCaps: { anthropic: { five_hour: 90 } },
      now,
    });

    expect(result).toEqual({ state: 'pass', snapshot_state: 'no_signal' });
  });

  it('subscription agent, no snapshot for provider → pass with no_signal', () => {
    const result = checkPressureCap(makeDeps({}));

    expect(result).toEqual({ state: 'pass', snapshot_state: 'no_signal' });
  });

  it('fresh + under cap → pass with fresh', () => {
    const result = checkPressureCap(makeDeps({
      anthropic: [
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'five_hour',
          used_pct: 50,
          observed_at: '2026-05-08T00:50:00Z',
        }),
      ],
    }));

    expect(result).toEqual({ state: 'pass', snapshot_state: 'fresh' });
  });

  it('fresh + at cap (used_pct === cap_pct) → refuse over_threshold', () => {
    const result = checkPressureCap(makeDeps({
      anthropic: [
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'five_hour',
          used_pct: 90,
          observed_at: '2026-05-08T00:50:00Z',
        }),
      ],
    }));

    expect(result).toEqual({
      state: 'refuse',
      reason: 'over_threshold',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 90,
      cap_pct: 90,
      snapshot_age_seconds: 600,
      snapshot_state: 'fresh',
    });
  });

  it('fresh + over cap → refuse over_threshold', () => {
    const result = checkPressureCap(makeDeps({
      anthropic: [
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'five_hour',
          used_pct: 91,
          observed_at: '2026-05-08T00:50:00Z',
        }),
      ],
    }));

    expect(result).toEqual({
      state: 'refuse',
      reason: 'over_threshold',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 91,
      cap_pct: 90,
      snapshot_age_seconds: 600,
      snapshot_state: 'fresh',
    });
  });

  it('stale + idle (under 50% of cap) → pass with stale_idle', () => {
    const result = checkPressureCap(makeDeps({
      anthropic: [
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'five_hour',
          used_pct: 30,
          observed_at: '2026-05-08T00:20:00Z',
        }),
      ],
    }));

    expect(result).toEqual({ state: 'pass', snapshot_state: 'stale_idle' });
  });

  it('stale + warm (>= 50% of cap) → refuse stale_warm', () => {
    const result = checkPressureCap(makeDeps({
      anthropic: [
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'five_hour',
          used_pct: 60,
          observed_at: '2026-05-08T00:20:00Z',
        }),
      ],
    }));

    expect(result).toEqual({
      state: 'refuse',
      reason: 'stale_warm',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 60,
      cap_pct: 90,
      snapshot_age_seconds: 2400,
      snapshot_state: 'stale_warm',
    });
  });

  it('multi-window — five_hour fresh under cap, seven_day fresh over cap → refuse on seven_day', () => {
    const result = checkPressureCap(makeDeps({
      anthropic: [
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'five_hour',
          used_pct: 50,
          observed_at: '2026-05-08T00:50:00Z',
        }),
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'seven_day',
          used_pct: 95,
          observed_at: '2026-05-08T00:50:00Z',
        }),
      ],
    }));

    expect(result).toEqual({
      state: 'refuse',
      reason: 'over_threshold',
      provider: 'anthropic',
      window_label: 'seven_day',
      used_pct: 95,
      cap_pct: 90,
      snapshot_age_seconds: 600,
      snapshot_state: 'fresh',
    });
  });

  it('multi-window — five_hour stale_warm, seven_day fresh under cap → refuse on five_hour', () => {
    const result = checkPressureCap(makeDeps({
      anthropic: [
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'five_hour',
          used_pct: 60,
          observed_at: '2026-05-08T00:20:00Z',
        }),
        makeSnapshot({
          provider: 'anthropic',
          window_label: 'seven_day',
          used_pct: 50,
          observed_at: '2026-05-08T00:50:00Z',
        }),
      ],
    }));

    expect(result).toEqual({
      state: 'refuse',
      reason: 'stale_warm',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 60,
      cap_pct: 90,
      snapshot_age_seconds: 2400,
      snapshot_state: 'stale_warm',
    });
  });

  it('per-window cap override', () => {
    const passResult = checkPressureCap({
      ...makeDeps({
        anthropic: [
          makeSnapshot({
            provider: 'anthropic',
            window_label: 'seven_day',
            used_pct: 85,
            observed_at: '2026-05-08T00:50:00Z',
          }),
        ],
      }),
      providerCaps: { anthropic: { five_hour: 80, seven_day: 95 } },
    });

    expect(passResult).toEqual({ state: 'pass', snapshot_state: 'fresh' });

    const refuseResult = checkPressureCap({
      ...makeDeps({
        anthropic: [
          makeSnapshot({
            provider: 'anthropic',
            window_label: 'five_hour',
            used_pct: 85,
            observed_at: '2026-05-08T00:50:00Z',
          }),
        ],
      }),
      providerCaps: { anthropic: { five_hour: 80, seven_day: 95 } },
    });

    expect(refuseResult).toEqual({
      state: 'refuse',
      reason: 'over_threshold',
      provider: 'anthropic',
      window_label: 'five_hour',
      used_pct: 85,
      cap_pct: 80,
      snapshot_age_seconds: 600,
      snapshot_state: 'fresh',
    });
  });
});
