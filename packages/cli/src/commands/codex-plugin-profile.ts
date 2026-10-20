import { lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export function validateCodexPluginProfilePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Codex profile path is not absolute and normalized");
  }

  const root = parse(path).root;
  let current = root;
  let nearest = root;
  let nearestStat = lstatSync(root);
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`Codex profile path contains a symlink: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Codex profile path contains a non-directory: ${current}`);
    }
    nearest = current;
    nearestStat = stat;
  }

  if (realpathSync(nearest) !== nearest) {
    throw new Error(`Codex profile ancestor is not canonical: ${nearest}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && nearestStat.uid !== uid) {
    throw new Error(
      `Codex profile or nearest existing ancestor is not owned by uid ${String(uid)}`,
    );
  }
}

export function prepareCodexPluginProfilePath(path: string): boolean {
  validateCodexPluginProfilePath(path);
  if (lstatSync(path, { throwIfNoEntry: false })) return false;
  if (!lstatSync(dirname(path), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Codex profile parent must exist before plugin installation");
  }
  mkdirSync(path, { mode: 0o700 });
  validateCodexPluginProfilePath(path);
  return true;
}

export function removePreparedCodexPluginProfilePath(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Preserve profiles once Codex or the user has placed state inside them.
  }
}
