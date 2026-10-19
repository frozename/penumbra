import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Returns true for repo-root paths covered by the root test shard
 * (`bun scripts/bun-test-gate.ts --path-ignore-patterns=packages/** ...`):
 * `scripts/` and `test/`. These are not package changes, but they carry real
 * test coverage, so they must not force the conservative full-suite fallback.
 */
export function isRootTestShardPath(path: string): boolean {
  return (
    path === "scripts" || path.startsWith("scripts/") || path === "test" || path.startsWith("test/")
  );
}

function defaultIsWorkspacePackageDir(dir: string): boolean {
  return existsSync(join(dir, "package.json"));
}

/**
 * Resolves a `packages/...` diff path to its package root. A
 * `packages/<group>/<name>/...` path maps to the nested root when
 * `packages/<group>` is not itself a workspace package (no package.json) —
 * e.g. `packages/integrations/typesafe`. Unresolvable shapes keep the
 * two-segment root, matching the pre-nesting behaviour.
 */
function resolvePackageRoot(
  path: string,
  isPackageDir: (packageDir: string) => boolean,
): string | null {
  const segments = path.split("/");
  const segment = segments[1];
  if (!segment) return null;
  const packageRoot = `packages/${segment}`;
  if (isPackageDir(packageRoot)) return packageRoot;
  const nested = segments[2];
  const nestedRoot = nested ? `${packageRoot}/${nested}` : null;
  return nestedRoot !== null && isPackageDir(nestedRoot) ? nestedRoot : packageRoot;
}

/**
 * Maps changed file paths to affected package roots.
 *
 * Returns:
 * - null for conservative full-suite fallback when any non-package path is touched
 * - [] when only docs/non-code paths changed
 * - a deduplicated sorted list of package roots otherwise
 *
 * Root `scripts/` and `test/` paths are not package changes: the tests stage
 * runs the repo root shard for them (see runTestsStage) instead of taking the
 * conservative fallback.
 */
export function resolveAffectedPackages(
  paths: string[],
  isPackageDir: (packageDir: string) => boolean = defaultIsWorkspacePackageDir,
): string[] | null {
  const packageRoots = new Set<string>();
  let docsOnly = true;

  for (const p of paths) {
    if (p.startsWith("packages/")) {
      const packageRoot = resolvePackageRoot(p, isPackageDir);
      if (packageRoot) {
        packageRoots.add(packageRoot);
        docsOnly = false;
      }
      continue;
    }

    if (p.startsWith("docs/") || p.startsWith(".github/")) {
      continue;
    }

    if (isRootTestShardPath(p)) {
      docsOnly = false;
      continue;
    }

    return null;
  }

  if (packageRoots.size === 0 && docsOnly) {
    return [];
  }

  return Array.from(packageRoots).sort();
}
