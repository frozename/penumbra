import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type WorktreeGitHooksStatus = "empty" | "installed" | "missing" | "not_configured";

export interface WorktreeGitHooks {
  status: WorktreeGitHooksStatus;
  /** The core.hooksPath value exactly as git reports it; null when unset. */
  configured: string | null;
}

const BARE_HUSKY_PREPARE = /^\s*husky(?:\s+install)?\s*$/;

/**
 * Read a worktree's package.json and return the argv to run husky directly,
 * only when the `prepare` script is a bare husky bootstrap (`husky` or
 * `husky install`). Returns `null` when the file is missing, not valid JSON,
 * or the prepare script is anything else — including mixed scripts like
 * `husky && bun run build` — so callers never execute arbitrary user code.
 * Prefers the worktree's own `node_modules/.bin/husky` when present, since
 * the isolated install runs with `--ignore-scripts` and husky is then
 * already on disk; falls back to `bun x husky` otherwise.
 */
export function detectHookInstallerArgv(wtPath: string): string[] | null {
  const packageJsonPath = path.join(wtPath, "package.json");
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: { prepare?: unknown } };
    const prepare = pkg.scripts?.prepare;
    if (typeof prepare !== "string" || !BARE_HUSKY_PREPARE.test(prepare)) return null;
    const localBin = path.join(wtPath, "node_modules", ".bin", "husky");
    return isExecutableFile(localBin) ? [localBin] : ["bun", "x", "husky"];
  } catch {
    return null;
  }
}

export function resolveGitHooksDir(wtPath: string, configured: string): string {
  if (configured === "~" || configured.startsWith("~/")) {
    return path.join(os.homedir(), configured.slice(1));
  }
  // git runs hooks from the working-tree root (githooks(5)), so a relative
  // core.hooksPath resolves inside each worktree, never in the main checkout.
  return path.isAbsolute(configured) ? configured : path.resolve(wtPath, configured);
}

const CLIENT_HOOK_NAMES: ReadonlySet<string> = new Set([
  "applypatch-msg",
  "commit-msg",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "p4-prepare-changelist",
  "post-applypatch",
  "post-checkout",
  "post-commit",
  "post-index-change",
  "post-merge",
  "post-rewrite",
  "pre-applypatch",
  "pre-auto-gc",
  "pre-commit",
  "pre-merge-commit",
  "pre-push",
  "pre-rebase",
  "prepare-commit-msg",
  "reference-transaction",
  "sendemail-validate",
]);

function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function classifyGitHooks(wtPath: string, configured: string | null): WorktreeGitHooks {
  if (configured === null) return { status: "not_configured", configured: null };
  // git treats an empty core.hooksPath as set and then runs no hooks at all.
  if (configured === "") return { status: "missing", configured };
  const dir = resolveGitHooksDir(wtPath, configured);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { status: "missing", configured };
  }
  const installed: boolean = entries.some(
    (name: string): boolean =>
      CLIENT_HOOK_NAMES.has(name) && isExecutableFile(path.join(dir, name)),
  );
  return { status: installed ? "installed" : "empty", configured };
}
