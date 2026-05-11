import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectRegistry } from './registry.js';

export function findProjectIdByCwd(
  registry: ProjectRegistry,
  cwd: string,
): string | undefined {
  const entries = registry.list();
  if (entries.length === 0) return undefined;

  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    return undefined;
  }

  const resolvedRoots: Array<{ id: string; root: string }> = [];
  for (const e of entries) {
    try {
      resolvedRoots.push({ id: e.project_id, root: realpathSync(e.root_path) });
    } catch {
      // Skip entries whose root_path does not exist locally.
    }
  }

  let longestMatchId: string | undefined;
  let longestMatchLength = -1;

  let currentPath = resolvedCwd;
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
