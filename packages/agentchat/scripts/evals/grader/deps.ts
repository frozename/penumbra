import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  defaultRunCommand,
  type GitLocator,
  isSafeRelativePath,
  listTreeEntries,
  readBlob,
  type RunCommand,
  type TreeEntry,
} from "./materialize.js";

export interface DepManifest {
  path: string;
  bytes: Uint8Array;
}

export interface BaseDepsInput {
  lockSha256: string;
  lockfileBytes: Uint8Array;
  manifests: DepManifest[];
}

export interface EnsureOk {
  ok: true;
  cacheDir: string;
}

export interface EnsureFail {
  ok: false;
  reason: string;
}

export type EnsureResult = EnsureOk | EnsureFail;

export interface DependencyProvider {
  ensure(input: BaseDepsInput): Promise<EnsureResult>;
}

export interface DefaultDependencyProviderOptions {
  cacheRoot: string;
  allowInstall: boolean;
  runCommand?: RunCommand;
  // Test seam: called after freezeTree, before the CACHE_MARKER write, so a
  // throwing hook can pin that the marker is committed only on a frozen cache.
  onAfterFreeze?: () => void;
}

const LOCKFILE_NAME = "bun.lock";
const MANIFEST_NAME = "package.json";
const CACHE_MARKER = ".penumbra-deps-cache-ok";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isManifestEntry(entry: TreeEntry): boolean {
  return (
    entry.type === "blob" &&
    !entry.path.split("/").includes("node_modules") &&
    (entry.path === MANIFEST_NAME || entry.path.endsWith(`/${MANIFEST_NAME}`))
  );
}

function workspacePatternsFrom(workspaces: unknown): string[] {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((p): p is string => typeof p === "string");
  }
  if (typeof workspaces === "object" && workspaces !== null && !Array.isArray(workspaces)) {
    const packages = "packages" in workspaces ? workspaces.packages : undefined;
    if (Array.isArray(packages)) {
      return packages.filter((p): p is string => typeof p === "string");
    }
  }
  return [];
}

function workspacePatterns(parsed: object): string[] {
  const workspaces = "workspaces" in parsed ? parsed.workspaces : undefined;
  return workspacePatternsFrom(workspaces);
}

function manifestPatternMatcher(pattern: string): RegExp | null {
  const normalized = pattern.replaceAll(/\/+$/g, "");
  if (normalized.length === 0) {
    return null;
  }
  const escaped = normalized.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replaceAll("*", "[^/]*");
  const tail = normalized.endsWith(MANIFEST_NAME) ? "" : "/package\\.json";
  return new RegExp(`^${body}${tail}$`);
}

function rootWorkspaces(bytes: Uint8Array): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return workspacePatterns(parsed);
}

function workspaceMatchers(bytes: Uint8Array): RegExp[] {
  const matchers: RegExp[] = [];
  for (const pattern of rootWorkspaces(bytes) ?? []) {
    const matcher = manifestPatternMatcher(pattern);
    if (matcher !== null) {
      matchers.push(matcher);
    }
  }
  return matchers;
}

async function collectManifests(
  run: RunCommand,
  locator: GitLocator,
  entries: TreeEntry[],
): Promise<DepManifest[]> {
  const candidates = entries.filter(isManifestEntry);
  const root = candidates.find((e) => e.path === MANIFEST_NAME);
  const manifests: DepManifest[] = [];
  let matchers: RegExp[] = [];
  if (root !== undefined) {
    const rootBytes = await readBlob(run, locator, root.oid);
    if (rootBytes !== null) {
      manifests.push({ path: root.path, bytes: rootBytes });
      matchers = workspaceMatchers(rootBytes);
    }
  }
  for (const entry of candidates) {
    if (entry.path === MANIFEST_NAME || !matchers.some((m) => m.test(entry.path))) {
      continue;
    }
    const bytes = await readBlob(run, locator, entry.oid);
    if (bytes !== null) {
      manifests.push({ path: entry.path, bytes });
    }
  }
  return manifests;
}

export async function readBaseDepsInput(opts: ReadBaseDepsInputOptions): Promise<BaseDepsInput> {
  const run = defaultRunCommand;
  const locator: GitLocator = { repo: opts.repo, sha: opts.baseSha, gitEnv: opts.gitEnv };
  const entries = await listTreeEntries(run, locator);
  if (entries === null) {
    throw new Error("base_missing");
  }
  const lockEntry = entries.find((e) => e.path === LOCKFILE_NAME && e.type === "blob");
  const lockfileBytes =
    lockEntry === undefined
      ? new Uint8Array()
      : ((await readBlob(run, locator, lockEntry.oid)) ?? new Uint8Array());
  const manifests = await collectManifests(run, locator, entries);
  return { lockSha256: sha256Hex(lockfileBytes), lockfileBytes, manifests };
}

function freezeTree(dir: string, includeRoot = true): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      continue;
    }
    if (ent.isDirectory()) {
      freezeTree(p);
    } else {
      chmodSync(p, statSync(p).mode & ~0o222);
    }
  }
  if (includeRoot) {
    chmodSync(dir, 0o555);
  }
}

async function installIntoCache(
  run: RunCommand,
  cacheDir: string,
  input: BaseDepsInput,
  onAfterFreeze?: () => void,
): Promise<EnsureResult> {
  for (const manifest of input.manifests) {
    if (!isSafeRelativePath(manifest.path)) {
      return { ok: false, reason: "deps_input_unsafe" };
    }
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, LOCKFILE_NAME), input.lockfileBytes);
  for (const manifest of input.manifests) {
    const target = join(cacheDir, manifest.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, manifest.bytes);
  }
  const install = await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: cacheDir,
  });
  if (install.code !== 0) {
    rmSync(cacheDir, { recursive: true, force: true });
    return { ok: false, reason: "deps_install_failed" };
  }
  // Freeze contents first, commit the marker last, then seal the root. A
  // crash anywhere before the marker write leaves an unmarked cache that
  // ensure() refuses to accept; a crash after the marker but before sealing
  // only leaves the root dir writable, never a half-installed accepted cache.
  freezeTree(cacheDir, false);
  onAfterFreeze?.();
  writeFileSync(join(cacheDir, CACHE_MARKER), `${input.lockSha256}\n`, "utf8");
  chmodSync(cacheDir, 0o555);
  return { ok: true, cacheDir };
}

export function createDefaultDependencyProvider(
  opts: DefaultDependencyProviderOptions,
): DependencyProvider {
  const run = opts.runCommand ?? defaultRunCommand;
  return {
    ensure: async (input: BaseDepsInput): Promise<EnsureResult> => {
      if (sha256Hex(input.lockfileBytes) !== input.lockSha256) {
        return { ok: false, reason: "deps_lock_mismatch" };
      }
      const cacheDir = join(opts.cacheRoot, input.lockSha256);
      if (existsSync(join(cacheDir, CACHE_MARKER))) {
        return { ok: true, cacheDir };
      }
      if (!opts.allowInstall) {
        return { ok: false, reason: "deps_cache_missing" };
      }
      const result = await installIntoCache(run, cacheDir, input, opts.onAfterFreeze);
      return result;
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function linkNodeModules(dest: string, target: string): void {
  if (!isDirectory(target)) {
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(resolve(target), dest, "dir");
}

export interface LinkDepsOptions {
  treeDir: string;
  cacheDir: string;
  workspaces: string[];
}

export function linkDeps(opts: LinkDepsOptions): Promise<void> {
  linkNodeModules(join(opts.treeDir, "node_modules"), join(opts.cacheDir, "node_modules"));
  for (const workspace of opts.workspaces) {
    linkNodeModules(
      join(opts.treeDir, workspace, "node_modules"),
      join(opts.cacheDir, workspace, "node_modules"),
    );
  }
  return Promise.resolve();
}

export interface ReadBaseDepsInputOptions {
  repo: string;
  baseSha: string;
  gitEnv?: NodeJS.ProcessEnv;
}
