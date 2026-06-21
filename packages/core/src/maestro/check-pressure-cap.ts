import type { SubscriptionPressureCache } from "./subscription-pressure-cache.js";

export type CapCheckPass = {
  state: "pass";
  snapshot_state: "fresh" | "stale_idle" | "no_signal" | "pricing_mode_skip";
};

export type CapCheckWarn = {
  state: "warn";
  provider: string;
  window_label: string;
  used_pct: number;
  warn_pct: number;
  refuse_pct: number;
  snapshot_age_seconds: number | null;
  snapshot_state: "fresh" | "stale_warm";
};

export type CapCheckRefuse = {
  state: "refuse";
  reason: "over_threshold" | "stale_warm" | "provider_synthetic_cap";
  provider: string;
  window_label: string;
  used_pct: number;
  cap_pct: number;
  resets_at: number | null;
  snapshot_age_seconds: number | null;
  snapshot_state: "fresh" | "stale_warm" | "no_signal";
};

export type CapCheckOutcome = CapCheckPass | CapCheckWarn | CapCheckRefuse;

export type WindowCaps = Record<string, { warn: number | null; refuse: number }>;
export type ProviderCaps = { default: WindowCaps; perModel?: Record<string, WindowCaps> };

export interface CheckPressureCapDeps {
  cache: Pick<SubscriptionPressureCache, "forProvider">;
  agent: {
    name: string;
    pricing_mode?: "api" | "subscription";
    subscription_provider?: string;
    subscription_model?: string;
  };
  providerCaps: Record<string, ProviderCaps>;
  defaultCapPct?: number;
  staleAfterSeconds?: number;
  now?: () => Date;
  syntheticCaps?: Record<string, { max_dispatches: number; window_seconds: number }>;
  getRecentDispatchCount?: (provider: string, windowSeconds: number) => number;
}

type Snapshot = ReturnType<SubscriptionPressureCache["forProvider"]>[number];

function checkSyntheticCap(provider: string, deps: CheckPressureCapDeps): CapCheckRefuse | null {
  const synthCap = deps.syntheticCaps?.[provider];
  if (!synthCap || !deps.getRecentDispatchCount) return null;
  const count = deps.getRecentDispatchCount(provider, synthCap.window_seconds);
  if (count < synthCap.max_dispatches) return null;
  return {
    state: "refuse",
    reason: "provider_synthetic_cap",
    provider,
    window_label: `${String(synthCap.window_seconds)}s_synthetic_cap`,
    used_pct: (count / synthCap.max_dispatches) * 100,
    cap_pct: 100,
    resets_at: null,
    snapshot_age_seconds: null,
    snapshot_state: "no_signal",
  };
}

function snapshotApplies(snapshot: Snapshot, subscriptionModel: string | undefined): boolean {
  if (subscriptionModel === undefined) return snapshot.model === null;
  return snapshot.model === null || snapshot.model === subscriptionModel;
}

type EvaluatedSnapshot =
  | { kind: "refuse"; outcome: CapCheckRefuse }
  | { kind: "warn"; outcome: CapCheckWarn }
  | { kind: "fresh" }
  | { kind: "stale_idle" };

function evaluateFreshSnapshot(
  snapshot: Snapshot,
  provider: string,
  cap: { warn: number | null; refuse: number },
  ageSeconds: number,
): EvaluatedSnapshot {
  if (snapshot.used_pct >= cap.refuse) {
    return {
      kind: "refuse",
      outcome: {
        state: "refuse",
        reason: "over_threshold",
        provider,
        window_label: snapshot.window_label,
        used_pct: snapshot.used_pct,
        cap_pct: cap.refuse,
        resets_at: snapshot.resets_at,
        snapshot_age_seconds: ageSeconds,
        snapshot_state: "fresh",
      },
    };
  }
  if (cap.warn !== null && snapshot.used_pct >= cap.warn) {
    return {
      kind: "warn",
      outcome: {
        state: "warn",
        provider,
        window_label: snapshot.window_label,
        used_pct: snapshot.used_pct,
        warn_pct: cap.warn,
        refuse_pct: cap.refuse,
        snapshot_age_seconds: ageSeconds,
        snapshot_state: "fresh",
      },
    };
  }
  return { kind: "fresh" };
}

function evaluateStaleSnapshot(
  snapshot: Snapshot,
  provider: string,
  cap: { warn: number | null; refuse: number },
  ageSeconds: number,
): EvaluatedSnapshot {
  if (snapshot.used_pct >= 0.5 * cap.refuse) {
    return {
      kind: "refuse",
      outcome: {
        state: "refuse",
        reason: "stale_warm",
        provider,
        window_label: snapshot.window_label,
        used_pct: snapshot.used_pct,
        cap_pct: cap.refuse,
        resets_at: snapshot.resets_at,
        snapshot_age_seconds: ageSeconds,
        snapshot_state: "stale_warm",
      },
    };
  }
  return { kind: "stale_idle" };
}

function evaluateSnapshot(
  snapshot: Snapshot,
  provider: string,
  providerEntry: ProviderCaps,
  defaultRefuseCap: number,
  staleAfterMs: number,
  nowMs: number,
): EvaluatedSnapshot {
  const perModelCaps = snapshot.model ? providerEntry.perModel?.[snapshot.model] : undefined;
  const windowCaps = perModelCaps ?? providerEntry.default;
  const cap = windowCaps[snapshot.window_label] ?? { warn: null, refuse: defaultRefuseCap };
  const ageMs = nowMs - new Date(snapshot.observed_at).getTime();
  const ageSeconds = Math.floor(ageMs / 1000);

  if (ageMs <= staleAfterMs) return evaluateFreshSnapshot(snapshot, provider, cap, ageSeconds);
  return evaluateStaleSnapshot(snapshot, provider, cap, ageSeconds);
}

type ScanState = {
  sawFresh: boolean;
  sawStaleIdle: boolean;
  warnOutcome: CapCheckWarn | null;
};

function applyEvaluatedSnapshot(state: ScanState, evaluated: EvaluatedSnapshot): void {
  if (evaluated.kind === "warn") {
    state.warnOutcome ??= evaluated.outcome;
    state.sawFresh = true;
  } else if (evaluated.kind === "fresh") {
    state.sawFresh = true;
  } else if (evaluated.kind === "stale_idle") {
    state.sawStaleIdle = true;
  }
}

function scanSnapshots(
  snapshots: Snapshot[],
  provider: string,
  subscriptionModel: string | undefined,
  providerEntry: ProviderCaps,
  defaultRefuseCap: number,
  staleAfterMs: number,
  nowMs: number,
): { refuse: CapCheckRefuse | null; state: ScanState } {
  const state: ScanState = { sawFresh: false, sawStaleIdle: false, warnOutcome: null };
  for (const snapshot of snapshots) {
    if (!snapshotApplies(snapshot, subscriptionModel)) continue;
    const evaluated = evaluateSnapshot(
      snapshot,
      provider,
      providerEntry,
      defaultRefuseCap,
      staleAfterMs,
      nowMs,
    );
    if (evaluated.kind === "refuse") return { refuse: evaluated.outcome, state };
    applyEvaluatedSnapshot(state, evaluated);
  }
  return { refuse: null, state };
}

function finalPassState(state: ScanState): CapCheckPass {
  if (state.sawFresh) return { state: "pass", snapshot_state: "fresh" };
  if (state.sawStaleIdle) return { state: "pass", snapshot_state: "stale_idle" };
  return { state: "pass", snapshot_state: "no_signal" };
}

export function checkPressureCap(deps: CheckPressureCapDeps): CapCheckOutcome {
  if (deps.agent.pricing_mode !== "subscription") {
    return { state: "pass", snapshot_state: "pricing_mode_skip" };
  }
  if (!deps.agent.subscription_provider) {
    return { state: "pass", snapshot_state: "no_signal" };
  }

  const provider = deps.agent.subscription_provider;
  const syntheticRefuse = checkSyntheticCap(provider, deps);
  if (syntheticRefuse) return syntheticRefuse;

  const providerEntry = deps.providerCaps[provider] ?? { default: {} };
  const defaultRefuseCap = deps.defaultCapPct ?? 90;
  const staleAfterMs = (deps.staleAfterSeconds ?? 1800) * 1000;
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const snapshots = deps.cache.forProvider(provider);

  if (snapshots.length === 0) {
    return { state: "pass", snapshot_state: "no_signal" };
  }

  const { refuse, state } = scanSnapshots(
    snapshots,
    provider,
    deps.agent.subscription_model,
    providerEntry,
    defaultRefuseCap,
    staleAfterMs,
    nowMs,
  );
  if (refuse) return refuse;
  if (state.warnOutcome) return state.warnOutcome;
  return finalPassState(state);
}
