import type { SubscriptionPressureCache } from './subscription-pressure-cache.js';

export type CapCheckPass = {
  state: 'pass';
  snapshot_state: 'fresh' | 'stale_idle' | 'no_signal' | 'pricing_mode_skip';
};

export type CapCheckRefuse = {
  state: 'refuse';
  reason: 'over_threshold' | 'stale_warm';
  provider: string;
  window_label: string;
  used_pct: number;
  cap_pct: number;
  snapshot_age_seconds: number | null;
  snapshot_state: 'fresh' | 'stale_warm';
};

export type CapCheckOutcome = CapCheckPass | CapCheckRefuse;

export interface CheckPressureCapDeps {
  cache: Pick<SubscriptionPressureCache, 'forProvider'>;
  agent: { name: string; pricing_mode?: 'api' | 'subscription'; subscription_provider?: string };
  providerCaps: Record<string, Record<string, number>>;
  defaultCapPct?: number;
  staleAfterSeconds?: number;
  now?: () => Date;
}

export function checkPressureCap(deps: CheckPressureCapDeps): CapCheckOutcome {
  if (deps.agent.pricing_mode !== 'subscription') {
    return { state: 'pass', snapshot_state: 'pricing_mode_skip' };
  }

  if (!deps.agent.subscription_provider) {
    return { state: 'pass', snapshot_state: 'no_signal' };
  }

  const caps = deps.providerCaps[deps.agent.subscription_provider] ?? {};
  const defaultCap = deps.defaultCapPct ?? 90;
  const staleAfterMs = (deps.staleAfterSeconds ?? 1800) * 1000;
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const snapshots = deps.cache.forProvider(deps.agent.subscription_provider);

  if (snapshots.length === 0) {
    return { state: 'pass', snapshot_state: 'no_signal' };
  }

  let sawFresh = false;
  let sawStaleIdle = false;

  for (const snapshot of snapshots) {
    const cap = caps[snapshot.window_label] ?? defaultCap;
    const ageMs = nowMs - new Date(snapshot.observed_at).getTime();
    const ageSeconds = Math.floor(ageMs / 1000);

    if (ageMs <= staleAfterMs) {
      if (snapshot.used_pct >= cap) {
        return {
          state: 'refuse',
          reason: 'over_threshold',
          provider: deps.agent.subscription_provider,
          window_label: snapshot.window_label,
          used_pct: snapshot.used_pct,
          cap_pct: cap,
          snapshot_age_seconds: ageSeconds,
          snapshot_state: 'fresh',
        };
      }

      sawFresh = true;
      continue;
    }

    if (snapshot.used_pct >= 0.5 * cap) {
      return {
        state: 'refuse',
        reason: 'stale_warm',
        provider: deps.agent.subscription_provider,
        window_label: snapshot.window_label,
        used_pct: snapshot.used_pct,
        cap_pct: cap,
        snapshot_age_seconds: ageSeconds,
        snapshot_state: 'stale_warm',
      };
    }

    sawStaleIdle = true;
  }

  return {
    state: 'pass',
    snapshot_state: sawFresh ? 'fresh' : (sawStaleIdle ? 'stale_idle' : 'no_signal'),
  };
}
