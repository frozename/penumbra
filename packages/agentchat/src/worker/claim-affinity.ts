/**
 * Cross-project claim affinity for warm-pooled agents.
 *
 * The daemon serves an approved handoff to every eligible worker at once (SSE);
 * the worker that claims first wins (atomic claimDispatch). For a warm-pooled
 * agent that is "first-poll-wins" spread means a project's dispatch often lands
 * on a worker homed to a DIFFERENT project — whose warm pool is keyed at ITS own
 * repoRoot — so the connection misses (`no_entry`) and the dispatch cold-starts.
 *
 * This PURE resolver computes how long a worker should hold back before claiming
 * a given handoff: 0 (claim immediately) for a worker that is home for the
 * handoff's project — it has, or pre-warms, the matching connection and should
 * win — and a small grace otherwise, so a home worker gets first claim. If no
 * home worker claims within the grace (all busy, or none exists), the
 * cross-project worker still claims afterwards, so overflow capacity is kept; it
 * only adds the grace to dispatches that would otherwise have missed the pool.
 *
 * "Home for the handoff" is defined exactly as the warm pool keys connections:
 * the worker's home repoRoot (`resolveProjectRoot(workerProjectId) ?? mainRepoPath`,
 * matching prewarm-targets.ts) equals the handoff's project repoRoot. So a shared
 * worker (no project_id → home = mainRepoPath) is "home" for the main project,
 * which is also where it pre-warms — keeping routing and warm-up consistent.
 */

export interface ClaimAffinityAgent {
  name: string;
  options?: { warm_pool?: boolean } | null;
}

export interface ClaimAffinityInput {
  /** The agent the handoff is routed to (`handoff.to_agent`). */
  toAgent: string;
  /** The handoff's project scope (`handoff.project_id`); null/undefined = global. */
  handoffProjectId?: string | null;
  /** Configured agents (to read the target's `warm_pool` flag). */
  agents: readonly ClaimAffinityAgent[];
  /** This worker's configured project_id (undefined for `shared`). */
  workerProjectId?: string;
  /** Resolve a project_id to its repo root — the SAME resolver prewarm uses
   *  (worktreeManager.projectRootFor), so "home" here == warm-pool home. */
  resolveProjectRoot: (projectId?: string) => string | undefined;
  /** Fallback repo root when a project has no resolver entry. */
  mainRepoPath: string;
  /** Grace to hold back a cross-project claim. <=0 disables affinity entirely. */
  graceMs: number;
}

/**
 * Milliseconds this worker should wait before claiming `toAgent`'s handoff.
 * 0 = claim now (non-warm agent, affinity disabled, or this worker is home).
 */
export function computeClaimGraceMs(input: ClaimAffinityInput): number {
  if (!Number.isFinite(input.graceMs) || input.graceMs <= 0) return 0;

  const agent = input.agents.find((a) => a.name === input.toAgent);
  // Only warm-pooled agents have a connection worth concentrating; everything
  // else claims immediately so affinity never adds latency where it can't help.
  if (agent?.options?.warm_pool !== true) return 0;

  const handoffRoot =
    input.resolveProjectRoot(input.handoffProjectId ?? undefined) ?? input.mainRepoPath;
  const workerHome = input.resolveProjectRoot(input.workerProjectId) ?? input.mainRepoPath;

  // Home worker for this project → it owns the matching warm connection; claim
  // now so it wins the first-poll race.
  if (handoffRoot === workerHome) return 0;

  // Cross-project + warm-pooled → hold back so a home worker can claim first.
  return input.graceMs;
}

/** Default grace; override via PENUMBRA_CLAIM_AFFINITY_GRACE_MS (0 disables). */
export const DEFAULT_CLAIM_AFFINITY_GRACE_MS = 500;
