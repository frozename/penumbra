import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type ProjectResolution =
  | {
      kind: "git";
      project_id: string;
      git_remote: string;
      git_relpath_root: string;
      repo_root: string;
    }
  | { kind: "marker"; project_id: string; marker_uuid: string; marker_path: string }
  | { kind: "declared"; project_id: string }
  | { kind: "quarantine"; project_id: null };

type GitResolution = Extract<ProjectResolution, { kind: "git" }>;

export interface ResolveOpts {
  cwd: string;
  declaredProjectId?: string;
  markerFileName?: string;
}

export interface ProjectIdResolverOpts {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

type CachedGitResolution = { resolution: GitResolution; fingerprint: string; expiresAt: number };

const DEFAULT_MARKER = ".penumbra-project";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 256;

// Git resolution is two blocking `git` spawns on the per-tool-call hook path,
// so git results are memoized by the cwd's realpath (a retargeted symlink is a
// new key; a deleted cwd has none and resolves uncached) and revalidated on
// every hit against the repo's git config stat. The TTL bounds what that stat
// cannot see: a repo nested under the cwd, a linked worktree's shared config.
export function createProjectIdResolver(
  cacheOpts: ProjectIdResolverOpts = {},
): (opts: ResolveOpts) => ProjectResolution {
  const ttlMs = cacheOpts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = cacheOpts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = cacheOpts.now ?? ((): number => performance.now());
  const cache = new Map<string, CachedGitResolution>();

  function lookup(realCwd: string): GitResolution | undefined {
    const entry = cache.get(realCwd);
    if (!entry) return undefined;
    cache.delete(realCwd);
    if (now() >= entry.expiresAt) return undefined;
    if (gitFingerprint(entry.resolution.repo_root) !== entry.fingerprint) return undefined;
    cache.set(realCwd, entry);
    return entry.resolution;
  }

  function remember(realCwd: string, resolution: GitResolution): GitResolution {
    const frozen = Object.freeze(resolution);
    const fingerprint = gitFingerprint(resolution.repo_root);
    if (fingerprint === null) return frozen;
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(realCwd, { resolution: frozen, fingerprint, expiresAt: now() + ttlMs });
    return frozen;
  }

  return (opts) => {
    if (opts.declaredProjectId) return { kind: "declared", project_id: opts.declaredProjectId };
    const realCwd = tryRealpath(opts.cwd);
    if (realCwd === null) return resolveGit(opts.cwd) ?? resolveFallback(opts);
    const cached = lookup(realCwd);
    if (cached) return cached;
    const git = resolveGit(realCwd);
    return git ? remember(realCwd, git) : resolveFallback(opts);
  };
}

export const resolveProjectId = createProjectIdResolver();

function resolveGit(cwd: string): GitResolution | null {
  const git = tryGit(cwd);
  if (!git) return null;
  const hash = createHash("sha256").update(git.remote).digest("hex").slice(0, 16);
  const realCwd = realpathSync(cwd);
  const rel = toPosix(relative(git.root, realCwd)) || ".";
  return {
    kind: "git",
    project_id: `${hash}:${rel}`,
    git_remote: git.remote,
    git_relpath_root: rel,
    repo_root: git.root,
  };
}

function resolveFallback(opts: ResolveOpts): ProjectResolution {
  const marker = tryMarker(opts.cwd, opts.markerFileName ?? DEFAULT_MARKER);
  if (marker) {
    return {
      kind: "marker",
      project_id: marker.uuid,
      marker_uuid: marker.uuid,
      marker_path: marker.path,
    };
  }

  return { kind: "quarantine", project_id: null };
}

// The origin URL lives in .git/config, which git rewrites by rename, so its
// stat moves on set-url, re-clone and deletion; .git's own mtime would churn on
// every `git status`. A linked worktree's .git is a pointer file instead.
function gitFingerprint(repoRoot: string): string | null {
  try {
    const dotGit = join(repoRoot, ".git");
    const dotGitStat = statSync(dotGit);
    const s = dotGitStat.isDirectory() ? statSync(join(dotGit, "config")) : dotGitStat;
    return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
  } catch {
    return null;
  }
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function tryGit(cwd: string): { remote: string; root: string } | null {
  const topLevel = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (topLevel.status !== 0) return null;
  const root = topLevel.stdout.trim();
  if (!root) return null;
  const remote = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  if (remote.status !== 0) return null;
  const url = remote.stdout.trim();
  if (!url) return null;
  return { remote: url, root };
}

function tryMarker(cwd: string, fileName: string): { uuid: string; path: string } | null {
  let dir = cwd;
  for (;;) {
    const p = join(dir, fileName);
    if (existsSync(p)) {
      const uuid = readFileSync(p, "utf8").trim();
      if (uuid) return { uuid, path: p };
    }
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
