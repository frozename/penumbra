import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultRunCommand, type RunCommand } from "./materialize.js";

export interface GraderBuildIdOptions {
  entrypoints?: string[];
  root?: string;
  bunVersion?: string;
  gitVersion?: string;
  runCommand?: RunCommand;
}

const DEFAULT_ENTRY_NAMES = ["grade.ts", "verify.ts", "probe-harness.ts"];

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

function hashIfExists(path: string): string | null {
  return existsSync(path) ? sha256Hex(readFileSync(path)) : null;
}

function defaultEntrypoints(root: string): string[] {
  const present = DEFAULT_ENTRY_NAMES.map((name) => join(root, name)).filter((path) =>
    existsSync(path),
  );
  if (present.length > 0) {
    return present;
  }
  return readdirSync(root)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(root, name));
}

// Bun's unminified output embeds `// <path>` comments relative to
// process.cwd(), so the emitted text is not a stable hash input. The metafile
// input map is: hash each resolved source file instead.
function hashMetafileInputs(inputPaths: string[], root: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const key of inputPaths) {
    const abs = resolve(process.cwd(), key);
    const rel = relative(root, abs).replaceAll("\\", "/");
    pairs.push([rel, sha256Hex(readFileSync(abs))]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1));
  return pairs;
}

async function resolveGitVersion(gitVersion: string | undefined, run: RunCommand): Promise<string> {
  if (gitVersion !== undefined) {
    return gitVersion;
  }
  const res = await run("git", ["--version"]);
  if (res.code !== 0) {
    throw new Error(`graderBuildId: git --version failed with code ${String(res.code)}`);
  }
  return res.stdout.toString("utf8").trim();
}

export async function graderBuildId(opts: GraderBuildIdOptions = {}): Promise<string> {
  const root = opts.root ?? dirname(fileURLToPath(import.meta.url));
  const entrypoints = opts.entrypoints ?? defaultEntrypoints(root);
  const run = opts.runCommand ?? defaultRunCommand;

  const result = await Bun.build({ entrypoints, target: "bun", minify: false, metafile: true });
  if (!result.success) {
    throw new Error(`graderBuildId: Bun.build failed: ${JSON.stringify(result.logs)}`);
  }
  if (result.metafile === undefined) {
    throw new Error("graderBuildId: Bun.build produced no metafile");
  }

  const sources = hashMetafileInputs(Object.keys(result.metafile.inputs), root);
  const id = sha256Hex(
    Buffer.from(
      canonicalJson({
        sources,
        bunfig: hashIfExists(join(root, "bunfig.toml")),
        profile: hashIfExists(join(root, "sandbox-darwin.sb")),
        bun: opts.bunVersion ?? Bun.version,
        git: await resolveGitVersion(opts.gitVersion, run),
      }),
      "utf8",
    ),
  );
  return id;
}
