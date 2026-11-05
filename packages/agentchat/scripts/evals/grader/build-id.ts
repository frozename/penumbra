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

// The build exists to hash sources, never to run them. Bare imports outside the
// hashed @penumbra/core evals closure (zod, @penumbra/api-contract, …) are
// marked external: under `bun test` the bundler cannot resolve workspace deps
// that are only linked inside a package's own node_modules (e.g.
// @penumbra/api-contract from packages/core/src/schemas), and traversing into
// node_modules is unnecessary anyway because those packages are not part of
// the grader sources the build id is meant to cover.
const HASHED_ROOT_PACKAGE = "@penumbra/core";

function isHashedSpecifier(path: string): boolean {
  const pkg = path.startsWith("@")
    ? path.split("/").slice(0, 2).join("/")
    : (path.split("/")[0] ?? path);
  return pkg === HASHED_ROOT_PACKAGE;
}

const externalizePackages: Bun.BunPlugin = {
  name: "grader-external-packages",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) =>
      isHashedSpecifier(args.path) ? undefined : { path: args.path, external: true },
    );
  },
};

export function graderBundleOptions(entrypoints: string[]): Bun.BuildConfig {
  return {
    entrypoints,
    target: "bun",
    minify: false,
    metafile: true,
    plugins: [externalizePackages],
  };
}

export interface GraderBundleOutcome {
  ok: boolean;
  text: string;
  inputs: string[];
  logs: string;
}

const BUNDLE_CHILD_TIMEOUT_MS = 120_000;

// An in-process Bun.build intermittently misreads sources (EISDIR, Unseekable,
// wrong file contents) once the grader harness has churned scratch trees in
// the same process — the file-reader cache serves stale entries for recycled
// inodes. A fresh short-lived bun process starts with an empty cache, which
// also keeps long-lived daemon/worker processes immune.
function bundleChildSource(moduleUrl: string): string {
  return [
    "const request = await Bun.stdin.json();",
    `const { graderBundleOptions } = await import(${JSON.stringify(moduleUrl)});`,
    "const result = await Bun.build(graderBundleOptions(request.entrypoints));",
    'let text = "";',
    "for (const output of result.outputs) { text += await output.text(); }",
    "const inputs = result.metafile === undefined ? [] : Object.keys(result.metafile.inputs);",
    "process.stdout.write(JSON.stringify({ ok: result.success, text, inputs, logs: JSON.stringify(result.logs) }));",
  ].join("\n");
}

export async function runGraderBundle(entrypoints: string[]): Promise<GraderBundleOutcome> {
  const proc = Bun.spawn([process.execPath, "-e", bundleChildSource(import.meta.url)], {
    // A FileSink pipe left the child reading an empty stdin; a Blob-backed
    // stdin delivers the request reliably.
    stdin: new Blob([JSON.stringify({ entrypoints })], { type: "application/json" }),
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(BUNDLE_CHILD_TIMEOUT_MS),
  });
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`runGraderBundle: bundle child exited ${String(code)}: ${stderrText}`);
  }
  return JSON.parse(stdoutText) as GraderBundleOutcome;
}

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

  const bundle = await runGraderBundle(entrypoints);
  if (!bundle.ok) {
    throw new Error(`graderBuildId: Bun.build failed: ${bundle.logs}`);
  }
  if (bundle.inputs.length === 0) {
    throw new Error("graderBuildId: Bun.build produced no metafile");
  }

  const sources = hashMetafileInputs(bundle.inputs, root);
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
