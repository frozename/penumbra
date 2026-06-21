import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import type { ProjectRegistry } from "./registry.js";

export function findProjectIdByCwd(registry: ProjectRegistry, cwd: string): string | undefined {
  const entries = registry.list();
  if (entries.length === 0) return undefined;

  const resolvedCwd = safeRealpath(cwd);
  if (resolvedCwd === undefined) return undefined;

  const resolvedRoots = collectResolvedRoots(entries);
  return walkAncestorsForLongestMatch(resolvedCwd, resolvedRoots);
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function collectResolvedRoots(
  entries: ReturnType<ProjectRegistry["list"]>,
): { id: string; root: string }[] {
  const out: { id: string; root: string }[] = [];
  for (const e of entries) {
    const root = safeRealpath(e.root_path);
    if (root !== undefined) out.push({ id: e.project_id, root });
  }
  return out;
}

function walkAncestorsForLongestMatch(
  startPath: string,
  resolvedRoots: { id: string; root: string }[],
): string | undefined {
  let longestMatchId: string | undefined;
  let longestMatchLength = -1;
  let currentPath = startPath;

  for (;;) {
    for (const { id, root } of resolvedRoots) {
      if (root === currentPath && root.length > longestMatchLength) {
        longestMatchId = id;
        longestMatchLength = root.length;
      }
    }
    const parent = dirname(currentPath);
    if (parent === currentPath) break;
    currentPath = parent;
  }
  return longestMatchId;
}
