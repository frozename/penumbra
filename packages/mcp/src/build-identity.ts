import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MCP_PACKAGE_VERSION = readPackageVersion();
export const MCP_SERVER_VERSION = `${MCP_PACKAGE_VERSION}+${resolveBuildMetadata()}`;

function readPackageVersion(): string {
  const raw = readFileSync(resolve(packageRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error("@penumbra/mcp package.json is missing a string version");
  }
  return parsed.version;
}

function resolveBuildMetadata(): string {
  const configured = normalizeBuildMetadata(process.env.PENUMBRA_MCP_BUILD_ID);
  if (configured) return configured;

  const gitSha = resolveGitSha();
  if (gitSha) return `git.${gitSha}`;

  return "unknown";
}

function resolveGitSha(): string | null {
  try {
    const raw = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalizeBuildMetadata(raw);
  } catch {
    return null;
  }
}

function normalizeBuildMetadata(value: string | undefined): string | null {
  const normalized = value
    ?.trim()
    .replaceAll(/[^0-9A-Za-z.-]/g, ".")
    .replaceAll(/\.+/g, ".")
    .replaceAll(/^\.+|\.+$/g, "");
  return normalized ? normalized.slice(0, 80) : null;
}
