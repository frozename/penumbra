import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
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
  // Test seams around the rename-aside of an unmarked cacheDir slot in
  // commitStagedInstall: the before-hook can simulate a cross-process commit
  // landing in the slot between the marker check and the rename; the
  // after-hook observes the commit sequence while the .stale-* residue is
  // still in place to inspect.
  onBeforeRenameStaleAside?: (staleAside: string) => void;
  onAfterRenameStaleAside?: (staleAside: string) => void;
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

function chmodTreeWritable(dir: string): void {
  try {
    const st = lstatSync(dir);
    // A stray file or symlink needs no tree walk: rmSync removes it directly.
    // Never follow the link either — chmodding through it would mutate
    // whatever external directory the stale slot happened to point at.
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return;
    }
    chmodSync(dir, st.mode | 0o700);
  } catch {
    return;
  }
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      continue;
    }
    if (ent.isDirectory()) {
      chmodTreeWritable(p);
    } else {
      try {
        chmodSync(p, statSync(p).mode | 0o700);
      } catch {
        // rmSync force tolerates entries chmod could not reach.
      }
    }
  }
}

// A crash between freezeTree and the CACHE_MARKER write leaves a frozen,
// unmarked cacheDir; a plain reinstall would EACCES writing bun.lock.
// Restore u+w, drop the stale dir, and let the install start from scratch.
function removeStaleCacheDir(cacheDir: string): void {
  chmodTreeWritable(cacheDir);
  rmSync(cacheDir, { recursive: true, force: true });
}

async function installIntoCache(
  run: RunCommand,
  cacheDir: string,
  input: BaseDepsInput,
  onAfterFreeze?: () => void,
): Promise<EnsureResult> {
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
  // Freeze contents first, commit the marker last. The root stays writable
  // until ensure() renames the staging dir into place (macOS rejects renaming
  // a read-only directory with EACCES) and seals it there. A crash anywhere
  // before the marker write leaves an unmarked cache that ensure() refuses to
  // accept; a crash after the marker but before sealing only leaves the root
  // dir writable, never a half-installed accepted cache.
  freezeTree(cacheDir, false);
  onAfterFreeze?.();
  writeFileSync(join(cacheDir, CACHE_MARKER), `${input.lockSha256}\n`, "utf8");
  return { ok: true, cacheDir };
}

function tryRenameIntoCache(stagedDir: string, cacheDir: string): boolean {
  try {
    renameSync(stagedDir, cacheDir);
    return true;
  } catch {
    // EEXIST/ENOTEMPTY: another ensure() committed its install first.
    return false;
  }
}

// Commits a marked, frozen stagedDir at cacheDir. A winner that committed
// while we installed is accepted as-is; a stale (unmarked) slot is renamed
// aside atomically to a unique .stale-* name and deleted there — never
// rm'd in place, so the cacheDir path never carries a half-removed tree and
// a crash mid-delete leaves identifiable .stale-* residue instead. The
// hooks are test seams around the rename-aside: they let tests pin the
// commit sequence and simulate a cross-process commit landing in the slot
// between the marker check and the rename.
function commitStagedInstall(
  cacheRoot: string,
  lockSha256: string,
  stagedDir: string,
  onBeforeRenameStaleAside?: (staleAside: string) => void,
  onAfterRenameStaleAside?: (staleAside: string) => void,
): EnsureResult {
  const cacheDir = join(cacheRoot, lockSha256);
  if (tryRenameIntoCache(stagedDir, cacheDir)) {
    chmodSync(cacheDir, 0o555);
    return { ok: true, cacheDir };
  }
  if (existsSync(join(cacheDir, CACHE_MARKER))) {
    removeStaleCacheDir(stagedDir);
    return { ok: true, cacheDir };
  }
  const staleAside = join(cacheRoot, `${lockSha256}.stale-${randomUUID()}`);
  onBeforeRenameStaleAside?.(staleAside);
  let renamedAside = false;
  try {
    // BSD/macOS refuse rename(2) on a read-only directory: restore u+w on the
    // stale root alone first — one atomic chmod leaving the same "frozen
    // tree, writable root" state the seal path already tolerates — then move
    // it. Files and symlinks rename without any chmod.
    const st = lstatSync(cacheDir);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      chmodSync(cacheDir, st.mode | 0o700);
    }
    renameSync(cacheDir, staleAside);
    renamedAside = true;
  } catch {
    // The slot emptied between the marker check and the rename (a concurrent
    // ensure() committed or swept it); nothing to move aside.
  }
  if (renamedAside) {
    onAfterRenameStaleAside?.(staleAside);
    if (existsSync(join(staleAside, CACHE_MARKER))) {
      // Another process committed a valid cache into the slot between our
      // marker check and the rename, and we just moved it aside. Restore it
      // and discard our staged install instead of deleting a sealed cache.
      // The restore rename only succeeded because we chmodded the root
      // writable, so reseal it with the same 0o555 the commit paths apply.
      removeStaleCacheDir(stagedDir);
      try {
        renameSync(staleAside, cacheDir);
        chmodSync(cacheDir, 0o555);
      } catch {
        // The slot was refilled after our rename-aside; the newest committed
        // cache wins and the restored aside is garbage.
        removeStaleCacheDir(staleAside);
      }
      return { ok: true, cacheDir };
    }
    removeStaleCacheDir(staleAside);
  }
  if (tryRenameIntoCache(stagedDir, cacheDir)) {
    chmodSync(cacheDir, 0o555);
    return { ok: true, cacheDir };
  }
  removeStaleCacheDir(stagedDir);
  return { ok: false, reason: "deps_install_failed" };
}

// Installs run in a unique staging dir next to cacheDir and are renamed into
// place only after freeze + marker, so a concurrent ensure() for the same
// lockSha can never removeStaleCacheDir the other's in-flight install. The
// loser of the rename accepts the winner's committed cache; the slot is only
// cleared for a rename onto a directory that lacks the marker (stale, since
// a committed cache is always marked before it is visible at cacheDir).
export function createDefaultDependencyProvider(
  opts: DefaultDependencyProviderOptions,
): DependencyProvider {
  const run = opts.runCommand ?? defaultRunCommand;
  return {
    ensure: async (input: BaseDepsInput): Promise<EnsureResult> => {
      if (sha256Hex(input.lockfileBytes) !== input.lockSha256) {
        return { ok: false, reason: "deps_lock_mismatch" };
      }
      for (const manifest of input.manifests) {
        if (!isSafeRelativePath(manifest.path)) {
          return { ok: false, reason: "deps_input_unsafe" };
        }
      }
      const cacheDir = join(opts.cacheRoot, input.lockSha256);
      if (existsSync(join(cacheDir, CACHE_MARKER))) {
        return { ok: true, cacheDir };
      }
      if (!opts.allowInstall) {
        return { ok: false, reason: "deps_cache_missing" };
      }
      mkdirSync(opts.cacheRoot, { recursive: true });
      const stagedDir = mkdtempSync(join(opts.cacheRoot, `${input.lockSha256}.install-`));
      let installed: EnsureResult;
      let threw = true;
      try {
        installed = await installIntoCache(run, stagedDir, input, opts.onAfterFreeze);
        threw = false;
      } finally {
        if (threw) {
          // Remove only this call's own staging dir: a sibling ensure() for
          // the same lockSha may be installing live under the same
          // <lockSha>.install-* prefix right now.
          removeStaleCacheDir(stagedDir);
        }
      }
      if (!installed.ok) {
        return installed;
      }
      return commitStagedInstall(
        opts.cacheRoot,
        input.lockSha256,
        stagedDir,
        opts.onBeforeRenameStaleAside,
        opts.onAfterRenameStaleAside,
      );
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
