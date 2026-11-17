import { SCHEMA_VERSION } from "@penumbra/core/db/schema";
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

type DeployManifest = {
  commit: string;
  schemaVersion: number;
  bunVersion: string;
  lockfileSha: string;
  builtAt: string;
};

function resolveLockfileSha(cwd: string): string {
  const lockfile = join(cwd, "bun.lock");
  if (!existsSync(lockfile)) {
    throw new Error(`${lockfile} not found in source tree`);
  }
  return createHash("sha256").update(readFileSync(lockfile)).digest("hex");
}

export function buildDeployManifest(cwd: string, commit: string): DeployManifest {
  return {
    commit,
    schemaVersion: SCHEMA_VERSION,
    bunVersion: Bun.version,
    lockfileSha: resolveLockfileSha(cwd),
    builtAt: new Date().toISOString(),
  };
}

export function writeDeployManifest(cwd: string, manifest: DeployManifest): void {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "DEPLOY_MANIFEST.json"), JSON.stringify(manifest, null, 2));
}

async function resolveCommitForSourceTree(source: string): Promise<string> {
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  try {
    const toplevelResult = await execFile("git", ["-C", source, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: gitEnv,
      timeout: 15_000,
    });
    const toplevel = toplevelResult.stdout.trim();
    if (toplevel !== realpathSync(source)) {
      throw new Error("nested directory inside git repo");
    }
    const result = await execFile("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: gitEnv,
      timeout: 15_000,
    });
    const commit = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error("cannot resolve commit");
    }
    return commit;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot resolve commit in ${source}: ${message}`);
  }
}

export async function writeDeployManifestFromSource(source: string, out: string): Promise<void> {
  const commit = await resolveCommitForSourceTree(source);
  writeDeployManifest(out, buildDeployManifest(source, commit));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let source: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && i + 1 < args.length) {
      source = args[++i];
    } else if (args[i] === "--out" && i + 1 < args.length) {
      out = args[++i];
    }
  }
  if (!source || !out) {
    process.stderr.write("Usage: penumbra-deploy-manifest --source <dir> --out <dir>\n");
    process.exit(1);
  }
  try {
    await writeDeployManifestFromSource(source, out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
