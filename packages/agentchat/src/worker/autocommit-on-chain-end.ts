import { execFile as execFileCb } from "node:child_process";
import { basename, extname } from "node:path";
import { promisify } from "node:util";

export interface WorktreeHandle {
  path: string;
}

export interface AutocommitDeps {
  execFile?: typeof execFileCb;
  log: {
    warn: (meta: Record<string, unknown>, msg: string) => void;
    debug: (meta: Record<string, unknown>, msg: string) => void;
  };
}

export const AUTOCOMMIT_HANOFF_ID_RE = /^[0-9a-f-]{36}$/i;

const DEFAULT_DENIED_PATTERNS = [
  ".env",
  ".env.",
  ".env.local",
  ".envrc",
  ".npmrc",
  ".netrc",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  "id_rsa",
  ".sqlite",
  ".sqlite3",
];

const DEFAULT_DENIED_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".sqlite",
  ".sqlite3",
]);

const NON_SOURCE_DIR_SEGMENTS = [
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "local_cache",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".vite",
  ".svelte-kit",
  ".parcel-cache",
] as const;

function isNonSourceArtifactPath(path: string): boolean {
  if (path.startsWith("/") || path.includes("..")) return true;
  const segments = path.split("/");
  return segments.some((segment) =>
    NON_SOURCE_DIR_SEGMENTS.includes(segment as (typeof NON_SOURCE_DIR_SEGMENTS)[number]),
  );
}

function isAllowedPath(path: string): boolean {
  if (!path) return false;
  return !isNonSourceArtifactPath(path);
}

function isDeniedPath(path: string): boolean {
  const candidate = path.toLowerCase();
  const base = basename(candidate);
  const strippedBase = base.replace(/(?:~|\.bak|\.old|\.orig|\.swp|\.swo|\.tmp|\.disabled)$/, "");
  const matchesSecretName = (name: string): boolean =>
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/.test(name) ||
    DEFAULT_DENIED_EXTENSIONS.has(extname(name)) ||
    /^\.env(?:\..*)?$/.test(name);
  if (matchesSecretName(base)) return true;
  if (base !== strippedBase && matchesSecretName(strippedBase)) return true;
  return DEFAULT_DENIED_PATTERNS.some((pattern) => {
    const normalized = pattern.toLowerCase();
    return candidate === normalized || candidate.startsWith(normalized) || base === normalized;
  });
}

export function parseGitStatusPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (line.length > 3 ? line.slice(3) : ""))
    .flatMap((entry) => {
      if (!entry) return [];
      const renamed = entry.split(" -> ");
      const last = renamed[renamed.length - 1];
      if (renamed.length > 1 && last !== undefined) return [last];
      return [entry];
    });
}

export function partitionAutocommitPaths(paths: string[]): {
  kept: string[];
  dropped: string[];
} {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const path of paths) {
    if (isAllowedPath(path) && !isDeniedPath(path)) {
      kept.push(path);
    } else {
      dropped.push(path);
    }
  }
  return { kept, dropped };
}

export function filterAutocommitPaths(paths: string[]): string[] {
  return partitionAutocommitPaths(paths).kept;
}

export async function autocommitOnChainEnd(
  handoff: { handoff_id: string; conversation_id: string; to_agent: string },
  wt: WorktreeHandle,
  deps: AutocommitDeps,
): Promise<boolean> {
  if (!AUTOCOMMIT_HANOFF_ID_RE.test(handoff.handoff_id)) {
    deps.log.warn(
      {
        component: "autocommit-on-chain-end",
        handoff_id: handoff.handoff_id,
        msg: "malformed handoff_id; skipping autocommit",
      },
      "autocommit on chain end skipped",
    );
    return false;
  }

  const execFile = deps.execFile ?? promisify(execFileCb);
  const { stdout } = await execFile(
    "git",
    ["-C", wt.path, "status", "--porcelain", "--untracked-files=all"],
    { maxBuffer: 1024 * 1024 },
  );
  const statusText =
    typeof stdout === "string" ? stdout : Buffer.isBuffer(stdout) ? stdout.toString("utf8") : "";
  const { kept: filtered, dropped } = partitionAutocommitPaths(parseGitStatusPaths(statusText));

  if (dropped.length > 0) {
    deps.log.warn(
      {
        component: "autocommit-on-chain-end",
        handoff_id: handoff.handoff_id,
        dropped_paths: dropped,
        kept_count: filtered.length,
      },
      "autocommit on chain end dropped paths",
    );
  }

  if (filtered.length === 0) {
    deps.log.warn(
      {
        component: "autocommit-on-chain-end",
        handoff_id: handoff.handoff_id,
        msg: "no safe paths to autocommit; skipping",
      },
      "autocommit on chain end skipped",
    );
    return false;
  }

  for (const path of filtered) {
    await execFile("git", ["-C", wt.path, "add", "--", path], { maxBuffer: 1024 * 1024 });
  }

  await execFile(
    "git",
    [
      "-C",
      wt.path,
      "commit",
      "-m",
      `wip(autocommit): chain ended with uncommitted changes -- agent ${handoff.to_agent} did not commit explicitly\n\nhandoff_id: ${handoff.handoff_id}\nconversation_id: ${handoff.conversation_id}\n\nAuto-generated by worker autocommit-on-chain-end recovery.`,
    ],
    { maxBuffer: 1024 * 1024 },
  );

  return true;
}
