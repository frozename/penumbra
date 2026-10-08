import { realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

function sbplLiteral(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Render a Seatbelt (sandbox-exec -p) profile: allow everything, deny
 * file-write* under every protected root. Used as the Layer B OS backstop
 * around penumbra-owned process spawns on profile dispatches. Roots MUST be
 * realpath-resolved by the caller (/tmp resolves to /private/tmp on macOS).
 */
export function renderSandboxExecProfile(roots: readonly string[]): string {
  const lines = ["(version 1)", "(allow default)"];
  for (const root of roots) {
    lines.push(`(deny file-write* (subpath ${sbplLiteral(root)}))`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Canonicalize a root for an SBPL subpath rule. realpathSync alone throws on
 * roots that do not exist yet (a caller cwd can be deleted between dispatch
 * and spawn), so missing tails resolve through their nearest real ancestor —
 * the deny rule still matches once the path is created under a symlinked
 * parent.
 */
function canonicalizeDenyRoot(path: string): string {
  const absPath = resolve(path);
  try {
    return realpathSync(absPath);
  } catch {
    const missing: string[] = [];
    let cursor = absPath;
    for (;;) {
      missing.unshift(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) return absPath;
      cursor = parent;
      try {
        const realParent = realpathSync(cursor);
        return resolve(realParent, ...missing);
      } catch {
        // keep climbing — parent directory may not yet exist
      }
    }
  }
}

/**
 * The deny-root set for a profile dispatch: the effective spawn cwd plus
 * every extra mutable root the dispatch could reach (caller cwd, project
 * root, worktree fleet base). Every entry is canonicalized (SBPL subpath
 * rules match resolved paths — /var→/private/var and symlinked parents
 * otherwise silently miss), deduped, and sorted for a stable profile.
 */
export function resolveSandboxDenyRoots(
  cwd: string,
  extraRoots?: readonly (string | null | undefined)[],
): string[] {
  const roots = new Set<string>();
  for (const root of [cwd, ...(extraRoots ?? [])]) {
    if (root === null || root === undefined || root === "") continue;
    const canonical = canonicalizeDenyRoot(root);
    roots.add(canonical.length > sep.length ? canonical.replace(/[/\\]+$/, "") : canonical);
  }
  return [...roots].sort();
}
