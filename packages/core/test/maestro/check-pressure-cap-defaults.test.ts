import { describe, expect, test } from "bun:test";

import { checkPressureCap, type CheckPressureCapDeps, type PressureSnapshot } from "@src/index.js";

const NOW = (): Date => new Date("2026-05-08T01:00:00Z");

function snap(
  partial: Partial<PressureSnapshot> &
    Pick<PressureSnapshot, "provider" | "window_label" | "used_pct" | "observed_at">,
): PressureSnapshot {
  return {
    provider: partial.provider,
    window_label: partial.window_label,
    model: partial.model ?? null,
    used_pct: partial.used_pct,
    resets_at: partial.resets_at ?? null,
    observed_at: partial.observed_at,
    source_kind: partial.source_kind ?? "statusline",
  };
}

function baseDeps(overrides: Partial<CheckPressureCapDeps> = {}): CheckPressureCapDeps {
  return {
    cache: { forProvider: () => [] },
    agent: { name: "agent", pricing_mode: "subscription", subscription_provider: "anthropic" },
    providerCaps: {},
    now: NOW,
    ...overrides,
  };
}

describe("checkPressureCap defaults and synthetic caps", () => {
  test("synthetic cap refuse returns the full provider_synthetic_cap shape", () => {
    const result = checkPressureCap(
      baseDeps({
        syntheticCaps: { anthropic: { max_dispatches: 10, window_seconds: 300 } },
        getRecentDispatchCount: () => 15,
      }),
    );

    expect(result).toEqual({
      state: "refuse",
      reason: "provider_synthetic_cap",
      provider: "anthropic",
      window_label: "300s_synthetic_cap",
      used_pct: 150,
      cap_pct: 100,
      resets_at: null,
      snapshot_age_seconds: null,
      snapshot_state: "no_signal",
    });
  });

  test("getRecentDispatchCount receives the provider and window seconds", () => {
    const calls: [string, number][] = [];

    checkPressureCap(
      baseDeps({
        syntheticCaps: { anthropic: { max_dispatches: 10, window_seconds: 300 } },
        getRecentDispatchCount: (provider: string, windowSeconds: number): number => {
          calls.push([provider, windowSeconds]);
          return 0;
        },
      }),
    );

    expect(calls).toEqual([["anthropic", 300]]);
  });

  test("synthetic cap refuse short-circuits snapshot evaluation", () => {
    const calls: string[] = [];

    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider(provider: string): PressureSnapshot[] {
            calls.push(provider);
            return [
              snap({
                provider: "anthropic",
                window_label: "five_hour",
                used_pct: 99,
                observed_at: "2026-05-08T00:50:00Z",
              }),
            ];
          },
        },
        providerCaps: {
          anthropic: { default: { five_hour: { warn: null, refuse: 90 } } },
        },
        syntheticCaps: { anthropic: { max_dispatches: 10, window_seconds: 300 } },
        getRecentDispatchCount: (): number => 10,
      }),
    );

    expect(result).toEqual({
      state: "refuse",
      reason: "provider_synthetic_cap",
      provider: "anthropic",
      window_label: "300s_synthetic_cap",
      used_pct: 100,
      cap_pct: 100,
      resets_at: null,
      snapshot_age_seconds: null,
      snapshot_state: "no_signal",
    });
    expect(calls).toEqual([]);
  });

  test("synthetic cap without getRecentDispatchCount falls through to snapshot evaluation", () => {
    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 10,
              observed_at: "2026-05-08T00:50:00Z",
            }),
          ],
        },
        providerCaps: {
          anthropic: { default: { five_hour: { warn: null, refuse: 90 } } },
        },
        syntheticCaps: { anthropic: { max_dispatches: 10, window_seconds: 300 } },
      }),
    );

    expect(result).toEqual({ state: "pass", snapshot_state: "fresh" });
  });

  test("synthetic cap keyed to a different provider is not consulted", () => {
    const calls: [string, number][] = [];

    const result = checkPressureCap(
      baseDeps({
        syntheticCaps: { openai: { max_dispatches: 1, window_seconds: 60 } },
        getRecentDispatchCount: (provider: string, windowSeconds: number): number => {
          calls.push([provider, windowSeconds]);
          return 99;
        },
      }),
    );

    expect(result).toEqual({ state: "pass", snapshot_state: "no_signal" });
    expect(calls).toEqual([]);
  });

  test("a window with no configured cap refuses at the built-in default of 90", () => {
    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 90,
              observed_at: "2026-05-08T00:50:00Z",
            }),
          ],
        },
      }),
    );

    expect(result).toEqual({
      state: "refuse",
      reason: "over_threshold",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 90,
      cap_pct: 90,
      resets_at: null,
      snapshot_age_seconds: 600,
      snapshot_state: "fresh",
    });
  });

  test("defaultCapPct replaces the built-in default refuse cap", () => {
    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 50,
              observed_at: "2026-05-08T00:50:00Z",
            }),
          ],
        },
        defaultCapPct: 40,
      }),
    );

    expect(result).toEqual({
      state: "refuse",
      reason: "over_threshold",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 50,
      cap_pct: 40,
      resets_at: null,
      snapshot_age_seconds: 600,
      snapshot_state: "fresh",
    });
  });

  test("staleAfterSeconds shortens the freshness window", () => {
    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 30,
              observed_at: "2026-05-08T00:50:00Z",
            }),
          ],
        },
        providerCaps: {
          anthropic: { default: { five_hour: { warn: null, refuse: 90 } } },
        },
        staleAfterSeconds: 60,
      }),
    );

    expect(result).toEqual({ state: "pass", snapshot_state: "stale_idle" });
  });

  test("a snapshot exactly at the default stale boundary is still fresh", () => {
    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 30,
              observed_at: "2026-05-08T00:30:00Z",
            }),
          ],
        },
        providerCaps: {
          anthropic: { default: { five_hour: { warn: null, refuse: 90 } } },
        },
      }),
    );

    expect(result).toEqual({ state: "pass", snapshot_state: "fresh" });
  });

  test("the first warn in snapshot order wins", () => {
    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 85,
              observed_at: "2026-05-08T00:50:00Z",
            }),
            snap({
              provider: "anthropic",
              window_label: "seven_day",
              used_pct: 88,
              observed_at: "2026-05-08T00:50:00Z",
            }),
          ],
        },
        providerCaps: {
          anthropic: {
            default: {
              five_hour: { warn: 80, refuse: 95 },
              seven_day: { warn: 80, refuse: 95 },
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      state: "warn",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 85,
      warn_pct: 80,
      refuse_pct: 95,
      snapshot_age_seconds: 600,
      snapshot_state: "fresh",
    });
  });

  test("a fresh pass outranks stale_idle in either snapshot order", () => {
    const providerCaps: CheckPressureCapDeps["providerCaps"] = {
      anthropic: {
        default: {
          five_hour: { warn: null, refuse: 90 },
          seven_day: { warn: null, refuse: 90 },
        },
      },
    };
    const staleFirst = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 10,
              observed_at: "2026-05-08T00:20:00Z",
            }),
            snap({
              provider: "anthropic",
              window_label: "seven_day",
              used_pct: 10,
              observed_at: "2026-05-08T00:50:00Z",
            }),
          ],
        },
        providerCaps,
      }),
    );
    const freshFirst = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "seven_day",
              used_pct: 10,
              observed_at: "2026-05-08T00:50:00Z",
            }),
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 10,
              observed_at: "2026-05-08T00:20:00Z",
            }),
          ],
        },
        providerCaps,
      }),
    );

    expect(staleFirst).toEqual({ state: "pass", snapshot_state: "fresh" });
    expect(freshFirst).toEqual({ state: "pass", snapshot_state: "fresh" });
  });

  test("snapshot_age_seconds is floored", () => {
    const result = checkPressureCap(
      baseDeps({
        cache: {
          forProvider: (): PressureSnapshot[] => [
            snap({
              provider: "anthropic",
              window_label: "five_hour",
              used_pct: 95,
              observed_at: "2026-05-08T00:50:00.400Z",
            }),
          ],
        },
        providerCaps: {
          anthropic: { default: { five_hour: { warn: null, refuse: 90 } } },
        },
      }),
    );

    expect(result).toEqual({
      state: "refuse",
      reason: "over_threshold",
      provider: "anthropic",
      window_label: "five_hour",
      used_pct: 95,
      cap_pct: 90,
      resets_at: null,
      snapshot_age_seconds: 599,
      snapshot_state: "fresh",
    });
  });
});
