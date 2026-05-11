import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectRegistry } from './registry.js';

export function findProjectIdByCwd(
  registry: ProjectRegistry,
  cwd: string,
): string | undefined {
  const entries = registry.list();
  if (entries.length === 0) return undefined;

  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return undefined;
  }

  const roots: Array<{ id: string; root: string }> = [];
  for (const e of entries) {
    try {
      roots.push({ id: e.project_id, root: realpathSync(e.root_path) });
    } catch {
      // Skip entries whose root_path does not exist locally.
    }
  }

  let bestId: string | undefined;
  let bestLen = -1;

  let cur = real;
  for (;;) {
    for (const { id, root } of roots) {
      if (root === cur && root.length > bestLen) {
        bestId = id;
        bestLen = root.length;
      }
    }

    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return bestId;
}
