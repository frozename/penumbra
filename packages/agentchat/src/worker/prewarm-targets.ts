/**
 * Phase 1 of the warm-pool x multi-worker integration: a PURE resolver that
 * computes the bounded set of `(agent, repoRoot)` tuples a worker should keep
 * warm at boot. No subprocesses and no effects beyond the injected `log` —
 * provably a subset of what the daemon would route to this worker.
 *
 * Every isolation mode pre-warms each opted-in agent at the worker's HOME
 * repoRoot (`resolveProjectRoot(workerProjectId) ?? mainRepoPath`):
 *   - a `hard` worker only ever receives its own project's dispatches, so home
 *     IS the only repoRoot it can be routed;
 *   - `sticky`/`shared` workers CAN claim cross-project work, but are
 *     deliberately bounded to home so the idle warm-process count stays
 *     (workers x eligible agents) rather than (x every project).
 * A worker whose project_id does not resolve (usually missing from
 * projects.yaml) still falls back to mainRepoPath, but warns through `log`:
 * otherwise it silently pre-warms the main repo instead of its own project.
 * The emitted repoRoot is byte-identical to the adapter's poolScope
 * (`repoRoot ?? cwd`, stdio-acp.ts) for that project, so the pre-warmed
 * connection is acquirable by the next matching dispatch.
 */

export type PrewarmIsolation = "hard" | "sticky" | "shared";

export type PrewarmTarget = { agent: string; repoRoot: string; slot: number };

export interface PrewarmAgent {
  name: string;
  options?: {
    warm_pool?: boolean;
    warm_pool_prewarm?: boolean;
    warm_pool_size?: number;
  } | null;
}

export interface ComputePrewarmTargetsInput {
  /** Configured agents, in config order (output order is stable to this). */
  agents: readonly PrewarmAgent[];
  /** This worker's isolation mode (kept for explicitness + the isolation matrix
   *  property test; the home-bounding rule is uniform across modes by design). */
  isolation: PrewarmIsolation;
  /** This worker's configured project_id, if any (undefined for `shared`). */
  workerProjectId?: string;
  /** Resolve a project_id to its repo root, mirroring the daemon/worktree path. */
  resolveProjectRoot: (projectId?: string) => string | undefined;
  /** Fallback repo root when the project has no resolver entry. */
  mainRepoPath: string;
  /** Hard cap on the number of tuples returned. */
  cap: number;
  /** Told when workerProjectId does not resolve and prewarm falls back to mainRepoPath. */
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

export function computePrewarmTargets(input: ComputePrewarmTargetsInput): PrewarmTarget[] {
  const { agents, workerProjectId, resolveProjectRoot, mainRepoPath, cap } = input;
  if (!Number.isFinite(cap) || cap <= 0) return [];

  const projectRoot = resolveProjectRoot(workerProjectId);
  const homeRepoRoot = projectRoot ?? mainRepoPath;
  const targets: PrewarmTarget[] = [];
  const seen = new Set<string>();

  for (const agent of agents) {
    if (addAgentTargets(agent, homeRepoRoot, targets, seen, cap)) break;
  }

  if (workerProjectId !== undefined && projectRoot === undefined && targets.length > 0) {
    input.log?.warn(
      {
        worker_project_id: workerProjectId,
        isolation: input.isolation,
        fallback_repo_root: mainRepoPath,
      },
      "prewarm-home-unresolved",
    );
  }

  return targets;
}

function addAgentTargets(
  agent: PrewarmAgent,
  homeRepoRoot: string,
  targets: PrewarmTarget[],
  seen: Set<string>,
  cap: number,
): boolean {
  const options = agent.options ?? {};
  if (options.warm_pool !== true || options.warm_pool_prewarm !== true) return false;

  const key = JSON.stringify([agent.name, homeRepoRoot]);
  if (seen.has(key)) return false;
  seen.add(key);

  const sizeRaw = options.warm_pool_size;
  const slots = Number.isInteger(sizeRaw) && sizeRaw !== undefined && sizeRaw > 0 ? sizeRaw : 1;
  for (let slot = 0; slot < slots; slot += 1) {
    targets.push({ agent: agent.name, repoRoot: homeRepoRoot, slot });
    if (targets.length >= cap) return true;
  }
  return targets.length >= cap;
}
