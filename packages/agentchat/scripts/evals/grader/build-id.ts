import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
// @penumbra/api-contract from packages/core/src/schemas). They are still
// folded into the build id via externalIdentities below.
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

// Externalized bare imports are excluded from the metafile inputs, so a bump
// of zod or @penumbra/api-contract would otherwise leave the build id (and
// every cached control keyed by it) unchanged while candidate semantics move.
// Fold each imported package's resolved version into the hash; for a
// workspace-linked (symlinked) package the version never moves when its
// source does, so hash the linked sources themselves instead.
const EXTERNAL_IMPORT_RE =
  /\b(?:from|import)\s*\(\s*["']([^"']+)["']|\b(?:from|import)\s+["']([^"']+)["']/g;

function packageOfSpecifier(spec: string): string {
  return spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : (spec.split("/")[0] ?? spec);
}

function externalSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  for (const match of content.matchAll(EXTERNAL_IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? "";
    if (
      spec === "" ||
      spec.startsWith(".") ||
      spec.startsWith("node:") ||
      spec.startsWith("bun:") ||
      isHashedSpecifier(spec)
    ) {
      continue;
    }
    specs.add(packageOfSpecifier(spec));
  }
  return [...specs];
}

function readPackageVersion(pkgJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgJson, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version: unknown = Reflect.get(parsed, "version");
      if (typeof version === "string") {
        return version;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Bun.resolveSync cannot read package.json through the exports map, so walk
// node_modules upward from the importing file like the runtime resolver does.
function resolveExternalPkgDir(spec: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const pkgDir = join(dir, "node_modules", spec);
    if (existsSync(join(pkgDir, "package.json"))) {
      return pkgDir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// GIT_* stripped so a GIT_DIR/GIT_WORK_TREE exported by a hook cannot point
// these probes at a foreign repository.
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  return env;
}

function runGitSync(pkgDir: string, args: string[]): { code: number; stdout: Buffer } {
  const res = spawnSync("git", ["-C", pkgDir, ...args], { env: scrubbedGitEnv() });
  return { code: res.status ?? -1, stdout: res.stdout };
}

function isGitWorkTree(dir: string): boolean {
  const res = runGitSync(dir, ["rev-parse", "--is-inside-work-tree"]);
  return res.stdout.toString("utf8").trim() === "true";
}

function gitVisibleFiles(pkgDir: string): string[] {
  const res = runGitSync(pkgDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (res.code !== 0) {
    throw new Error(
      `graderBuildId: git ls-files in ${pkgDir} failed with code ${String(res.code)}`,
    );
  }
  const paths = res.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function hashGitVisiblePackage(pkgDir: string, hash: ReturnType<typeof createHash>): void {
  for (const path of gitVisibleFiles(pkgDir)) {
    const abs = join(pkgDir, path);
    let isFile: boolean;
    try {
      isFile = lstatSync(abs).isFile();
    } catch {
      hash.update(`/${path}\0<deleted>\0`);
      continue;
    }
    if (!isFile) {
      continue;
    }
    hash.update(`/${path}\0`);
    hash.update(readFileSync(abs));
    hash.update("\0");
  }
}

// A workspace-linked package keeps its version while its source moves, so a
// version-only identity would leave the build id (and controls keyed by it)
// stale across edits to the linked package. Hash the linked sources instead.
// Inside a git work tree, hash only the git-visible files (tracked plus
// untracked non-ignored): gitignored build output (dist/, *.tsbuildinfo) must
// not move the id, while a new unstaged source file still does. Outside a
// work tree, fall back to a deterministic walk (sorted entries), skipping
// nested node_modules/.git and symlinks, tagging each file by relative path.
function hashLinkedPackage(pkgDir: string): string {
  const hash = createHash("sha256");
  if (isGitWorkTree(pkgDir)) {
    hashGitVisiblePackage(pkgDir, hash);
  } else {
    hashWalkedPackage(pkgDir, hash);
  }
  return hash.digest("hex").slice(0, 32);
}

function hashWalkedPackage(pkgDir: string, hash: ReturnType<typeof createHash>): void {
  const walk = (current: string, rel: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name === b.name ? 0 : a.name < b.name ? -1 : 1,
    );
    for (const ent of entries) {
      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git") {
          continue;
        }
        walk(join(current, ent.name), `${rel}/${ent.name}`);
      } else {
        hash.update(`${rel}/${ent.name}\0`);
        hash.update(readFileSync(join(current, ent.name)));
        hash.update("\0");
      }
    }
  };
  walk(pkgDir, "");
}

function externalIdentity(spec: string, fromDir: string): string {
  const pkgDir = resolveExternalPkgDir(spec, fromDir);
  if (pkgDir === null) {
    return `${spec}@unresolved`;
  }
  const version = readPackageVersion(join(pkgDir, "package.json")) ?? "unresolved";
  let linked = false;
  try {
    linked = lstatSync(pkgDir).isSymbolicLink();
  } catch {
    linked = false;
  }
  if (!linked) {
    return `${spec}@${version}`;
  }
  return `${spec}@${version}+linked:${hashLinkedPackage(realpathSync(pkgDir))}`;
}

function externalIdentities(inputPaths: string[]): string[] {
  const entries = new Set<string>();
  for (const key of inputPaths) {
    const abs = resolve(process.cwd(), key);
    for (const spec of externalSpecifiers(readFileSync(abs, "utf8"))) {
      entries.add(externalIdentity(spec, dirname(abs)));
    }
  }
  return [...entries].sort();
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
        externals: externalIdentities(bundle.inputs),
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
