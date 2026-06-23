import { resolveProjectId, type Services } from "@penumbra/core";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { json } from "./_helpers.js";

const execFile = promisify(execFileCb);

// Exclude high-churn paths so a `dirty` count reflects real source edits rather
// than build artifacts in the daemon's home checkout. Mirrors worktrees.ts.
const STATUS_EXCLUDE_PATHS = [
  ".",
  ":(exclude)node_modules",
  ":(exclude)packages/*/node_modules",
  ":(exclude).test-storage",
] as const;

// The daemon's own repo identity is immutable for the process lifetime, but
// resolveProjectId resolves it via two BLOCKING spawnSync git calls. Memoize the
// successful result so it is computed once, not on every (5s) poll — keeps the
// synchronous git out of the request hot path. A null (transient git failure) is
// left uncached so it self-heals on the next poll.
let projectIdCache: { repoRoot: string; projectId: string } | null = null;

function resolveProjectIdCached(repoRoot: string): string | null {
  if (projectIdCache?.repoRoot === repoRoot) return projectIdCache.projectId;
  let projectId: string | null = null;
  try {
    projectId = resolveProjectId({ cwd: repoRoot }).project_id;
  } catch {
    projectId = null;
  }
  if (projectId !== null) projectIdCache = { repoRoot, projectId };
  return projectId;
}

/**
 * Reports the daemon's OWN repository identity + git state for the console
 * Explorer PROJECT card. Fails CLOSED: any field that cannot be resolved is
 * null, never fabricated — preserving the anti-fabrication invariant the
 * interim Explorer fix (01bc1f71) established, where the card renders "—" on
 * null instead of a hardcoded path / always-"main"/always-clean badge.
 *
 * `dirty` counts only TRACKED modifications (--untracked-files=no): the daemon's
 * checkout is the home repo, churned by fleet worktrees and untracked build
 * residue, so an untracked-inclusive count would be meaningless noise.
 */
export async function workspaceRoute(_req: Request, services: Services): Promise<Response> {
  // mainRepoDir is threaded into the WorktreeManager (BuildServicesOpts), not
  // onto the Services object itself — read it where it actually lives.
  const repoRoot = services.worktreeManager.mainRepoDir;

  const projectId = resolveProjectIdCached(repoRoot);

  const [branch, dirty] = await Promise.all([
    execFile("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])
      .then((r) => r.stdout.trim() || null)
      .catch(() => null),
    execFile("git", [
      "-C",
      repoRoot,
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      ...STATUS_EXCLUDE_PATHS,
    ])
      .then((r) => r.stdout.split("\n").filter((line) => line.trim().length > 0).length)
      .catch(() => null),
  ]);

  return json({ projectId, branch, dirty });
}
