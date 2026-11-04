import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RunCommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array;
}

export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: RunCommandOptions,
) => Promise<RunCommandResult>;

export function defaultRunCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.stdin.on("error", () => {
      // A failed spawn destroys stdin (EPIPE/ERR_STREAM_DESTROYED); the
      // child's own 'error' event already carries the failure.
    });
    child.on("error", (err) => {
      resolve({
        code: -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.from(String(err)),
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

export interface ModelFailure {
  reason: "contract_violation";
  detail: Record<string, unknown>;
}

export interface UnknownFailure {
  reason: string;
  detail?: Record<string, unknown>;
}

export interface MaterializeOk {
  ok: true;
  treeDir: string;
  removed: string[];
}

export interface MaterializeFail {
  ok: false;
  model_failure?: ModelFailure;
  unknown?: UnknownFailure;
}

export type MaterializeResult = MaterializeOk | MaterializeFail;

export interface MaterializeOptions {
  repo: string;
  sha: string;
  outDir: string;
  runCommand?: RunCommand;
  gitEnv?: NodeJS.ProcessEnv;
}

export interface GitLocator {
  repo: string;
  sha: string;
  gitEnv?: NodeJS.ProcessEnv;
}

export interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const BLOB_MODES = new Set(["100644", "100755"]);
const EXECUTABLE_MODE = "100755";

const DROPPED_BASENAMES = new Set([".bunfig.toml", ".env", ".npmrc", "bunfig.toml"]);
const DROPPED_BASENAME_PATTERNS = [/^\.env\./, /^tsconfig.*\.json$/];

function gitRunOptions(locator: GitLocator): RunCommandOptions {
  const runOpts: RunCommandOptions = { cwd: locator.repo };
  if (locator.gitEnv !== undefined) {
    runOpts.env = locator.gitEnv;
  }
  return runOpts;
}

function parseLsTreeRecord(record: string): TreeEntry | null {
  const tab = record.indexOf("\t");
  if (tab < 0) {
    return null;
  }
  const [mode, type, oid] = record.slice(0, tab).split(" ");
  if (mode === undefined || type === undefined || oid === undefined) {
    return null;
  }
  return { mode, type, oid, path: record.slice(tab + 1) };
}

export async function listTreeEntries(
  run: RunCommand,
  locator: GitLocator,
): Promise<TreeEntry[] | null> {
  const res = await run(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", locator.sha],
    gitRunOptions(locator),
  );
  if (res.code !== 0) {
    return null;
  }
  const entries: TreeEntry[] = [];
  for (const record of res.stdout.toString("utf8").split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const entry = parseLsTreeRecord(record);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

export async function readBlob(
  run: RunCommand,
  locator: GitLocator,
  oid: string,
): Promise<Buffer | null> {
  const res = await run("git", ["cat-file", "blob", oid], gitRunOptions(locator));
  return res.code === 0 ? res.stdout : null;
}

// git recognizes a .git directory case-insensitively and through HFS+
// ignorable-Unicode and NTFS short-name / trailing-dot-space aliases
// (is_hfs_dotgit / is_ntfs_dotgit). On case-insensitive filesystems those
// aliases land as a real .git and let the candidate drive git (core.fsmonitor).
const HFS_IGNORABLE_CODEPOINTS = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;
const NTFS_SHORT_NAME_DOTGIT = /^git~\d+$/i;

function isGitDirSegment(segment: string): boolean {
  const stripped = segment.replaceAll(HFS_IGNORABLE_CODEPOINTS, "");
  if (stripped.toLowerCase() === ".git" || NTFS_SHORT_NAME_DOTGIT.test(stripped)) {
    return true;
  }
  const trimmed = stripped.replaceAll(/[. ]+$/g, "");
  return (
    trimmed !== stripped &&
    (trimmed.toLowerCase() === ".git" || NTFS_SHORT_NAME_DOTGIT.test(trimmed))
  );
}

export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) {
    return false;
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || isGitDirSegment(segment)) {
      return false;
    }
  }
  return true;
}

function isContainedIn(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function findCaseCollisions(entries: TreeEntry[]): string[] {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [entry.path]);
    } else if (!group.includes(entry.path)) {
      group.push(entry.path);
    }
  }
  const collided: string[] = [];
  for (const group of groups.values()) {
    if (group.length > 1) {
      collided.push(...group);
    }
  }
  return collided.sort();
}

function findContractViolation(entries: TreeEntry[], outDir: string): ModelFailure | null {
  const root = resolve(outDir);
  for (const entry of entries) {
    if (entry.type !== "blob" || !BLOB_MODES.has(entry.mode)) {
      return {
        reason: "contract_violation",
        detail: { path: entry.path, mode: entry.mode },
      };
    }
    // The graded commit is candidate-controlled; git mktree can carry '..'
    // subtrees that ls-tree flattens into '../...' paths. Reject before any
    // write so traversal cannot escape outDir.
    if (!isSafeRelativePath(entry.path) || !isContainedIn(root, resolve(root, entry.path))) {
      return {
        reason: "contract_violation",
        detail: { path: entry.path, unsafe_path: true },
      };
    }
  }
  const collisions = findCaseCollisions(entries);
  if (collisions.length > 0) {
    return { reason: "contract_violation", detail: { case_collision: collisions } };
  }
  return null;
}

function isDroppedPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.includes("node_modules")) {
    return true;
  }
  const base = segments.at(-1) ?? "";
  return DROPPED_BASENAMES.has(base) || DROPPED_BASENAME_PATTERNS.some((p) => p.test(base));
}

function isPackageJson(path: string): boolean {
  return path === "package.json" || path.endsWith("/package.json");
}

function copyRecordWithoutBun(parsed: object): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "bun") {
      rest[key] = value;
    }
  }
  return rest;
}

function neutralizePackageJsonBytes(bytes: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  if (!Object.hasOwn(parsed, "bun")) {
    return null;
  }
  return Buffer.from(`${JSON.stringify(copyRecordWithoutBun(parsed), null, 2)}\n`, "utf8");
}

type EntryOutcome =
  | { ok: true; removedTag: string | null }
  | { ok: false; failure: UnknownFailure };

async function materializeEntry(
  entry: TreeEntry,
  run: RunCommand,
  locator: GitLocator,
  outDir: string,
): Promise<EntryOutcome> {
  if (isDroppedPath(entry.path)) {
    return { ok: true, removedTag: entry.path };
  }
  const blob = await readBlob(run, locator, entry.oid);
  if (blob === null) {
    return {
      ok: false,
      failure: {
        reason: "materialize_error",
        detail: { path: entry.path, oid: entry.oid },
      },
    };
  }
  let fileBytes = blob;
  let removedTag: string | null = null;
  if (isPackageJson(entry.path)) {
    const neutralized = neutralizePackageJsonBytes(blob);
    if (neutralized !== null) {
      fileBytes = neutralized;
      removedTag = `${entry.path}#bun`;
    }
  }
  const target = join(outDir, entry.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fileBytes);
  if (entry.mode === EXECUTABLE_MODE) {
    chmodSync(target, 0o755);
  }
  return { ok: true, removedTag };
}

export async function materialize(opts: MaterializeOptions): Promise<MaterializeResult> {
  const run = opts.runCommand ?? defaultRunCommand;
  if (!FULL_SHA_PATTERN.test(opts.sha)) {
    return { ok: false, unknown: { reason: "base_missing" } };
  }
  const locator: GitLocator = { repo: opts.repo, sha: opts.sha, gitEnv: opts.gitEnv };
  const verify = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${opts.sha}^{commit}`],
    gitRunOptions(locator),
  );
  if (verify.code !== 0) {
    return { ok: false, unknown: { reason: "base_missing" } };
  }
  const entries = await listTreeEntries(run, locator);
  if (entries === null) {
    return { ok: false, unknown: { reason: "materialize_error", detail: { step: "ls-tree" } } };
  }
  const violation = findContractViolation(entries, opts.outDir);
  if (violation !== null) {
    return { ok: false, model_failure: violation };
  }
  mkdirSync(opts.outDir, { recursive: true });
  const removed: string[] = [];
  for (const entry of entries) {
    const outcome = await materializeEntry(entry, run, locator, opts.outDir);
    if (!outcome.ok) {
      return { ok: false, unknown: outcome.failure };
    }
    if (outcome.removedTag !== null) {
      removed.push(outcome.removedTag);
    }
  }
  return { ok: true, treeDir: opts.outDir, removed: removed.sort() };
}
