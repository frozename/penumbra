import type { SubscriptionPressureCache } from './subscription-pressure-cache.js';

export type CapCheckPass = {
  state: 'pass';
  snapshot_state: 'fresh' | 'stale_idle' | 'no_signal' | 'pricing_mode_skip';
};

export type CapCheckWarn = {
  state: 'warn';
  provider: string;
  window_label: string;
  used_pct: number;
  warn_pct: number;
  refuse_pct: number;
  snapshot_age_seconds: number | null;
  snapshot_state: 'fresh' | 'stale_warm';
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

export type CapCheckOutcome = CapCheckPass | CapCheckWarn | CapCheckRefuse;

export interface CheckPressureCapDeps {
  cache: Pick<SubscriptionPressureCache, 'forProvider'>;
  agent: { name: string; pricing_mode?: 'api' | 'subscription'; subscription_provider?: string };
  providerCaps: Record<string, Record<string, { warn: number | null; refuse: number }>>;
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
  const defaultRefuseCap = deps.defaultCapPct ?? 90;
  const staleAfterMs = (deps.staleAfterSeconds ?? 1800) * 1000;
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const snapshots = deps.cache.forProvider(deps.agent.subscription_provider);

  if (snapshots.length === 0) {
    return { state: 'pass', snapshot_state: 'no_signal' };
  }

  let sawFresh = false;
  let sawStaleIdle = false;
  let warnOutcome: CapCheckWarn | null = null;

  for (const snapshot of snapshots) {
    const cap = caps[snapshot.window_label] ?? { warn: null, refuse: defaultRefuseCap };
    const ageMs = nowMs - new Date(snapshot.observed_at).getTime();
    const ageSeconds = Math.floor(ageMs / 1000);

    if (ageMs <= staleAfterMs) {
      if (snapshot.used_pct >= cap.refuse) {
        return {
          state: 'refuse',
          reason: 'over_threshold',
          provider: deps.agent.subscription_provider,
          window_label: snapshot.window_label,
          used_pct: snapshot.used_pct,
          cap_pct: cap.refuse,
          snapshot_age_seconds: ageSeconds,
          snapshot_state: 'fresh',
        };
      }

      if (warnOutcome === null && cap.warn !== null && snapshot.used_pct >= cap.warn) {
        warnOutcome = {
          state: 'warn',
          provider: deps.agent.subscription_provider,
          window_label: snapshot.window_label,
          used_pct: snapshot.used_pct,
          warn_pct: cap.warn,
          refuse_pct: cap.refuse,
          snapshot_age_seconds: ageSeconds,
          snapshot_state: 'fresh',
        };
      }

      sawFresh = true;
      continue;
    }

    // Stale-warm snapshots only hard-stop; soft-warn injection happens in Phase 2.
    if (snapshot.used_pct >= 0.5 * cap.refuse) {
      return {
        state: 'refuse',
        reason: 'stale_warm',
        provider: deps.agent.subscription_provider,
        window_label: snapshot.window_label,
        used_pct: snapshot.used_pct,
        cap_pct: cap.refuse,
        snapshot_age_seconds: ageSeconds,
        snapshot_state: 'stale_warm',
      };
    }

    sawStaleIdle = true;
  }

  if (warnOutcome !== null) {
    return warnOutcome;
  }

  return {
    state: 'pass',
    snapshot_state: sawFresh ? 'fresh' : (sawStaleIdle ? 'stale_idle' : 'no_signal'),
  };
}
