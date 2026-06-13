/**
 * Phase 3+4 of the warm-pool x multi-worker integration: the worker-local
 * pre-warm loop. A PURE, fully-injected control loop that keeps a bounded set
 * of `(agent, repoRoot)` warm connections alive so warm reuse engages
 * regardless of the daemon's first-poll-wins worker spread — without touching
 * any daemon/claim code.
 *
 * Responsibilities:
 *   - boot pass: pre-warm every desired target once (Phase 3);
 *   - self-heal refresh: re-warm a target whose warm connection has aged past
 *     `refreshIntervalMs` (set to ~0.5 x warm_pool_max_age_ms by the caller),
 *     replacing it before the pool's own max-age eviction (Phase 3);
 *   - cost ceiling: never let pre-warm push the worker above `cap` live warm
 *     processes (Phase 4);
 *   - crash containment: a failing prewarm backs off exponentially and, after
 *     `breakerThreshold` consecutive failures, trips a per-agent breaker so a
 *     flaky binary can never become a tight respawn loop that amplifies the
 *     worker crash-storm (Phase 4).
 *
 * All effects (spawning, time, scheduling, entry counting) are injected, so the
 * loop is deterministic under test and carries no global state.
 */

import type { PrewarmTarget } from "./prewarm-targets.js";

export interface PrewarmLoopClock {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval: (handle: unknown) => void;
}

export interface PrewarmLoopDeps {
  /** The (agent, repoRoot) tuples this worker should keep warm right now.
   *  Already flag/isolation-filtered + cap-truncated by `computePrewarmTargets`.
   *  Re-read every pass so config reloads take effect without restarting. */
  computeTargets: () => PrewarmTarget[];
  /** Establish + deposit one warm connection for a target. Resolves on a
   *  successful deposit; REJECTS on spawn/handshake failure (drives backoff). */
  prewarmOne: (target: PrewarmTarget) => Promise<void>;
  /** Total live warm processes on this worker (registry totalAcpWarmPoolEntryCount). */
  countEntries: () => number;
  /** Whether a live warm entry already exists for a target. When provided, the
   *  loop re-warms a target that is missing an entry even before it ages
   *  (self-heals a crashed pre-warm). Omitted ⇒ refresh purely on age. */
  hasLiveEntry?: (target: PrewarmTarget) => boolean;
  clock: PrewarmLoopClock;
  /** Hard ceiling on live warm processes; a first-warm is skipped at the cap. */
  cap: number;
  /** Re-warm (replace) a target whose last success is older than this. */
  refreshIntervalMs: number;
  /** How often the loop wakes to check targets. Defaults to refreshIntervalMs.
   *  Set SHORTER than refreshIntervalMs (e.g. 60s) so a crashed pre-warm
   *  self-heals promptly via hasLiveEntry without forcing the expensive
   *  proactive replace to run that often. */
  tickIntervalMs?: number;
  /** Base exponential-backoff delay after a failed prewarm. Default 5s. */
  backoffBaseMs?: number;
  /** Backoff ceiling. Default 5min. */
  backoffMaxMs?: number;
  /** Consecutive failures before a per-agent breaker trips. Default 5. */
  breakerThreshold?: number;
  log?: (level: "info" | "warn" | "error", obj: Record<string, unknown>, msg: string) => void;
}

export interface PrewarmLoop {
  /** Run the boot pass, then schedule the refresh interval. */
  start: () => Promise<void>;
  /** Run a single pass now. The interval calls this; exposed for tests. */
  tick: () => Promise<void>;
  /** Re-evaluate targets after a config reload (prunes de-flagged state, warms new). */
  reload: () => Promise<void>;
  /** Stop the refresh interval. Pre-warmed connections are torn down separately
   *  by the pool's own shutdown — this only stops scheduling new work. */
  stop: () => void;
}

interface TargetState {
  failures: number;
  /** Earliest clock time a (re)warm of this target may be attempted. */
  nextEligibleAt: number;
  /** Clock time of the last successful prewarm; undefined ⇒ never warmed. */
  lastSuccessAt?: number;
  breakerTripped: boolean;
}

function keyOf(t: PrewarmTarget): string {
  return JSON.stringify([t.agent, t.repoRoot, t.slot]);
}

export function createPrewarmLoop(deps: PrewarmLoopDeps): PrewarmLoop {
  const backoffBaseMs = deps.backoffBaseMs ?? 5_000;
  const backoffMaxMs = deps.backoffMaxMs ?? 300_000;
  const breakerThreshold = deps.breakerThreshold ?? 5;
  const log = deps.log ?? (() => {});
  const state = new Map<string, TargetState>();
  let timer: { unref?: () => void } | null = null;
  let running = false;

  function getState(key: string): TargetState {
    let st = state.get(key);
    if (!st) {
      st = { failures: 0, nextEligibleAt: 0, breakerTripped: false };
      state.set(key, st);
    }
    return st;
  }

  async function runPass(): Promise<void> {
    // Single-flight: a slow pass (subprocess spawns) must never overlap with the
    // next interval tick, or the cap accounting and per-target backoff race.
    if (running) return;
    running = true;
    try {
      const targets = deps.computeTargets();
      const liveKeys = new Set(targets.map(keyOf));
      // Forget targets no longer desired (e.g. de-flagged on reload) so a later
      // re-flag is treated as a fresh first-warm rather than a stale refresh.
      for (const k of [...state.keys()]) if (!liveKeys.has(k)) state.delete(k);

      for (const target of targets) {
        const key = keyOf(target);
        const st = getState(key);
        if (st.breakerTripped) continue;

        const now = deps.clock.now();
        const aged =
          st.lastSuccessAt === undefined || now - st.lastSuccessAt >= deps.refreshIntervalMs;
        // Re-warm when the connection has aged out OR has gone missing (a crashed
        // pre-warm self-heals without waiting for the next refresh interval).
        const hasLive = deps.hasLiveEntry ? deps.hasLiveEntry(target) : true;
        if (hasLive && !aged) continue; // a fresh warm connection already exists
        if (now < st.nextEligibleAt) continue; // backing off after a failure

        // Cost ceiling. A first-warm needs headroom; a refresh replaces an
        // existing entry in place, so it is allowed even at the cap.
        if (st.lastSuccessAt === undefined && deps.countEntries() >= deps.cap) {
          log("warn", { agent: target.agent, cap: deps.cap }, "prewarm-cap-reached");
          continue;
        }

        try {
          await deps.prewarmOne(target);
          st.failures = 0;
          st.nextEligibleAt = 0;
          st.lastSuccessAt = deps.clock.now();
        } catch (err) {
          st.failures += 1;
          const backoff = Math.min(backoffBaseMs * 2 ** (st.failures - 1), backoffMaxMs);
          st.nextEligibleAt = deps.clock.now() + backoff;
          if (st.failures >= breakerThreshold) {
            st.breakerTripped = true;
            log(
              "error",
              { agent: target.agent, repoRoot: target.repoRoot, failures: st.failures },
              "prewarm-breaker-tripped",
            );
          } else {
            log(
              "warn",
              {
                agent: target.agent,
                repoRoot: target.repoRoot,
                failures: st.failures,
                backoff_ms: backoff,
                err: err instanceof Error ? err.message : String(err),
              },
              "prewarm-failed",
            );
          }
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    async start(): Promise<void> {
      await runPass();
      const tickMs = deps.tickIntervalMs ?? deps.refreshIntervalMs;
      if (tickMs > 0) {
        timer = deps.clock.setInterval(() => void runPass(), tickMs);
        timer.unref?.();
      }
    },
    tick: runPass,
    reload: runPass,
    stop(): void {
      if (timer) {
        deps.clock.clearInterval(timer);
        timer = null;
      }
    },
  };
}
