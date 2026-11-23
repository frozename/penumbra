import * as fs from "node:fs";
import * as path from "node:path";

export const PACKAGE_MANAGERS = ["bun", "npm"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const ISOLATED_INSTALL_ARGS = ["install", "--ignore-scripts", "--frozen-lockfile"] as const;
export const ISOLATED_INSTALL_CACHE_KEY = `bun ${ISOLATED_INSTALL_ARGS.join(" ")}`;
const NPM_ISOLATED_INSTALL_ARGS = ["ci", "--ignore-scripts"] as const;

export interface IsolatedInstallCommand {
  manager: PackageManager;
  argv: [string, ...string[]];
  // Part of the reconciler's test-baseline cache key: two install commands
  // never share a baseline.
  cacheKey: string;
  // Why this manager was chosen, for error messages.
  reason: string;
}

// Order is the precedence: a bun lockfile always wins, so a bun project that
// also carries another manager's lockfile installs exactly as it always has.
const LOCKFILE_MANAGERS: readonly (readonly [string, PackageManager | "pnpm" | "yarn"])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

function commandFor(manager: PackageManager, reason: string): IsolatedInstallCommand {
  const argv: [string, ...string[]] =
    manager === "npm" ? ["npm", ...NPM_ISOLATED_INSTALL_ARGS] : ["bun", ...ISOLATED_INSTALL_ARGS];
  return { manager, argv, cacheKey: argv.join(" "), reason };
}

/**
 * Picks the install command for an isolated-install worktree: the project's
 * declared `package_manager` when there is one, otherwise the lockfile in the
 * worktree root. No lockfile at all keeps the historical bun command.
 */
export function resolveIsolatedInstallCommand(
  wtPath: string,
  declared?: PackageManager,
): IsolatedInstallCommand {
  if (declared !== undefined) {
    return commandFor(declared, `package_manager: ${declared} in projects.yaml`);
  }
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (!fs.existsSync(path.join(wtPath, lockfile))) continue;
    if (manager === "pnpm" || manager === "yarn") {
      throw new Error(
        `isolated install cannot run in ${wtPath}: found ${lockfile}, and ${manager} is not a supported package manager (supported: ${PACKAGE_MANAGERS.join(", ")}). ` +
          "Set package_manager for the project in projects.yaml if one of those can install it, or dispatch with isolated_install: false.",
      );
    }
    return commandFor(manager, `${lockfile} in the worktree root`);
  }
  return commandFor("bun", "no lockfile in the worktree root");
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isOnPath(binary: string, searchPath: string): boolean {
  return searchPath
    .split(path.delimiter)
    .some((dir) => dir.length > 0 && isExecutableFile(path.join(dir, binary)));
}

/**
 * The worker runs the install with its own environment, and a service PATH
 * often lacks node. Fail before spawning with the missing binary and the PATH
 * that was searched, instead of a bare ENOENT. bun is not checked: the worker
 * itself runs on it.
 */
export function assertInstallBinariesOnPath(
  command: IsolatedInstallCommand,
  env: NodeJS.ProcessEnv,
): void {
  if (command.manager !== "npm") return;
  const searchPath = env.PATH ?? "";
  // npm is a node script: without node on PATH it dies with exit 127.
  const missing = ["npm", "node"].filter((binary) => !isOnPath(binary, searchPath));
  if (missing.length === 0) return;
  throw new Error(
    `isolated npm install cannot run: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not on PATH ` +
      `(npm was chosen because of ${command.reason}; PATH=${searchPath}). ` +
      "Add the directory that holds it to PATH in the worker's launch configuration and restart the worker.",
  );
}
