import type { Dirent } from "node:fs";

import ignoreFactory, { type Ignore as IgnoreManager } from "ignore";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const GLOB_DEFAULT_MAX = 1000;
const GLOB_HARD_CEILING = 5000;
const GREP_CONTENT_DEFAULT_MAX = 50;
const GREP_CONTENT_HARD_CEILING = 500;
const GREP_FILES_DEFAULT_MAX = 1000;
const GREP_FILES_HARD_CEILING = 5000;
const PER_LINE_TEXT_CAP = 1024;

export interface GlobArgs {
  pattern: string;
  path?: string | null;
  max_results?: number | null;
  include_ignored?: boolean | null;
}

export interface GlobResult {
  results: string[];
  truncated: boolean;
}

export type GrepOutputMode = "content" | "files_with_matches";

export interface GrepArgs {
  pattern: string;
  path?: string | null;
  glob?: string | null;
  output_mode?: GrepOutputMode | null;
  case_insensitive?: boolean | null;
  include_ignored?: boolean | null;
  max_results?: number | null;
}

export interface GrepContentRow {
  path: string;
  line: number;
  text: string;
}

export interface GrepResult {
  results: GrepContentRow[] | string[];
  truncated: boolean;
}

export class GrepError extends Error {
  constructor(
    public readonly code: "engine_unavailable" | "bad_pattern" | "io",
    message: string,
  ) {
    super(message);
    this.name = "GrepError";
  }
}

interface PathWithMtime {
  rel: string;
  mtimeMs: number;
}

type BunGlob = InstanceType<typeof Bun.Glob>;

interface RipgrepMatch {
  absPath: string;
  lineNumber: number;
  relPath: string;
  text: string;
}

type GrepErrorCode = "engine_unavailable" | "bad_pattern" | "io";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasErrorCode(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readGitignore(dir: string): Promise<IgnoreManager | null> {
  try {
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    return (ignoreFactory as unknown as () => IgnoreManager)().add(content);
  } catch (err: unknown) {
    if (hasErrorCode(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
}

function rgBinary(): string {
  return process.env.PENUMBRA_RG_BINARY ?? "rg";
}

async function populateGitignoreCache(
  dir: string,
  cache: Map<string, IgnoreManager | null>,
): Promise<void> {
  if (cache.has(dir)) {
    return;
  }

  const filter = await readGitignore(dir);
  cache.set(dir, filter);

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await populateGitignoreCache(path.join(dir, entry.name), cache);
    }
  }
}

function isIgnoredByGitignores(
  absPath: string,
  worktreeRoot: string,
  cache: Map<string, IgnoreManager | null>,
): boolean {
  const relDir = path.relative(worktreeRoot, path.dirname(absPath));
  if (relDir.startsWith("..") || path.isAbsolute(relDir)) {
    return false;
  }

  const dirs: string[] = [worktreeRoot];
  if (relDir) {
    let current = worktreeRoot;
    for (const segment of relDir.split(path.sep)) {
      current = path.join(current, segment);
      dirs.push(current);
    }
  }

  let ignored = false;
  for (const dir of dirs) {
    const filter = cache.get(dir) ?? null;
    if (!filter) continue;

    const result = filter.test(path.relative(dir, absPath));
    if (result.ignored || result.unignored) {
      ignored = result.ignored;
    }
  }

  return ignored;
}

function capTextLine(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PER_LINE_TEXT_CAP) return text;
  let slice = Buffer.from(text, "utf8").subarray(0, PER_LINE_TEXT_CAP - 3);

  while (isUtf8ContinuationByte(slice.at(-1))) {
    slice = slice.subarray(0, slice.length - 1);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (slice.length > 0) {
    try {
      return `${decoder.decode(slice)}…`;
    } catch {
      slice = slice.subarray(0, slice.length - 1);
      while (isUtf8ContinuationByte(slice.at(-1))) {
        slice = slice.subarray(0, slice.length - 1);
      }
    }
  }

  return "…";
}

async function* scanGlob(glob: BunGlob, searchRoot: string): AsyncGenerator<string, void, unknown> {
  try {
    yield* glob.scan({ cwd: searchRoot, onlyFiles: true, absolute: false });
  } catch (err: unknown) {
    if (!hasErrorCode(err, "ERR_INVALID_THIS")) {
      throw err;
    }
    yield* scanGlobByWalking(glob, searchRoot);
  }
}

async function* scanGlobByWalking(
  glob: BunGlob,
  root: string,
  relDir = "",
): AsyncGenerator<string, void, unknown> {
  const dir = relDir ? path.join(root, relDir) : root;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      yield* scanGlobByWalking(glob, root, rel);
    } else if (entry.isFile() && glob.match(rel)) {
      yield rel;
    }
  }
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0b1100_0000) === 0b1000_0000;
}

function parseRipgrepMatch(line: string, worktreeRoot: string): RipgrepMatch | null {
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(event) || event.type !== "match" || !isRecord(event.data)) {
    return null;
  }

  const pathValue = isRecord(event.data.path) ? event.data.path.text : null;
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return null;
  }

  const linesValue = isRecord(event.data.lines) ? event.data.lines.text : "";
  const text = typeof linesValue === "string" ? linesValue.replace(/\r?\n$/, "") : "";
  const lineNumber = typeof event.data.line_number === "number" ? event.data.line_number : 0;
  const absPath = path.resolve(worktreeRoot, pathValue);

  return {
    absPath,
    lineNumber,
    relPath: path.relative(worktreeRoot, absPath),
    text,
  };
}

export async function executeGlob(args: GlobArgs, worktree: string): Promise<GlobResult> {
  const defaultMax = GLOB_DEFAULT_MAX;
  const cap = Math.min(args.max_results ?? defaultMax, GLOB_HARD_CEILING);
  const worktreeRoot = await fs.realpath(worktree);
  const searchRoot = args.path ? path.resolve(worktreeRoot, args.path) : worktreeRoot;
  const gitignoreCache = args.include_ignored ? null : new Map<string, IgnoreManager | null>();
  if (gitignoreCache) {
    await populateGitignoreCache(worktreeRoot, gitignoreCache);
  }
  const glob = new Bun.Glob(args.pattern);
  const collected: PathWithMtime[] = [];

  for await (const rel of scanGlob(glob, searchRoot)) {
    const abs = path.resolve(searchRoot, rel);
    const relFromWorktree = path.relative(worktreeRoot, abs);
    if (relFromWorktree.startsWith("..") || path.isAbsolute(relFromWorktree)) {
      continue;
    }
    if (gitignoreCache && isIgnoredByGitignores(abs, worktreeRoot, gitignoreCache)) {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    collected.push({ rel: relFromWorktree, mtimeMs: stat.mtimeMs });
  }

  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const truncated = collected.length > cap;
  return {
    results: collected.slice(0, cap).map((entry) => entry.rel),
    truncated,
  };
}

export async function executeGrep(args: GrepArgs, worktree: string): Promise<GrepResult> {
  const outputMode: GrepOutputMode = args.output_mode ?? "content";
  const defaultMax = outputMode === "content" ? GREP_CONTENT_DEFAULT_MAX : GREP_FILES_DEFAULT_MAX;
  const ceiling = outputMode === "content" ? GREP_CONTENT_HARD_CEILING : GREP_FILES_HARD_CEILING;
  const cap = Math.max(0, Math.min(args.max_results ?? defaultMax, ceiling));
  const worktreeRoot = await fs.realpath(worktree);
  const searchRoot = args.path ? path.resolve(worktreeRoot, args.path) : worktreeRoot;
  const rgTarget = path.relative(worktreeRoot, searchRoot) || ".";
  const gitignoreCache = args.include_ignored ? null : new Map<string, IgnoreManager | null>();
  if (gitignoreCache) {
    await populateGitignoreCache(worktreeRoot, gitignoreCache);
  }

  const rgArgs: string[] = ["--no-config", "--json", "--with-filename"];
  if (args.case_insensitive) rgArgs.push("-i");
  if (args.glob) rgArgs.push("-g", args.glob);
  if (args.include_ignored) rgArgs.push("--no-ignore");
  rgArgs.push("--", args.pattern, rgTarget);

  if (outputMode === "content") {
    return await collectRipgrepResults<GrepContentRow>({
      cap,
      gitignoreCache,
      rgArgs,
      toResult: (match) => ({
        path: match.relPath,
        line: match.lineNumber,
        text: capTextLine(match.text),
      }),
      worktreeRoot,
    });
  }

  const seenPaths = new Set<string>();
  return await collectRipgrepResults<string>({
    cap,
    gitignoreCache,
    rgArgs,
    toResult: (match) => {
      if (seenPaths.has(match.relPath)) {
        return null;
      }
      seenPaths.add(match.relPath);
      return match.relPath;
    },
    worktreeRoot,
  });
}

interface RipgrepCollectOptions<Result> {
  cap: number;
  gitignoreCache: Map<string, IgnoreManager | null> | null;
  rgArgs: string[];
  toResult: (match: RipgrepMatch) => Result | null;
  worktreeRoot: string;
}

interface LineDrainResult {
  buffer: string;
  stopped: boolean;
}

async function collectRipgrepResults<Result>(
  options: RipgrepCollectOptions<Result>,
): Promise<{ results: Result[]; truncated: boolean }> {
  return await new Promise<{ results: Result[]; truncated: boolean }>((resolve, reject) => {
    const { cap, gitignoreCache, rgArgs, toResult, worktreeRoot } = options;
    const child = spawn(rgBinary(), rgArgs, { cwd: worktreeRoot });
    const results: Result[] = [];
    let stderr = "";
    let buffer = "";
    let killed = false;
    let emitted = 0;

    const finishWithError = (code: GrepErrorCode, message: string): void => {
      reject(new GrepError(code, message));
    };

    child.on("error", (err: unknown) => {
      if (hasErrorCode(err, "ENOENT")) {
        finishWithError(
          "engine_unavailable",
          `ripgrep not found (binary: ${rgBinary()}). Set PENUMBRA_RG_BINARY or install ripgrep.`,
        );
        return;
      }
      finishWithError("io", errorMessage(err));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (killed) return;
      const drained = drainRipgrepLines(buffer + chunk.toString("utf8"), (line) => {
        const result = collectLineResult(line, options);
        if (result === null) {
          return true;
        }
        emitted += 1;
        if (emitted > cap) {
          killed = true;
          child.kill();
          resolve({ results, truncated: true });
          return false;
        }
        results.push(result);
        return true;
      });
      buffer = drained.buffer;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code: number | null) => {
      if (killed) return;
      if (code === 0 || code === 1) {
        resolve({ results, truncated: false });
        return;
      }

      const codeText = code === null ? "null" : String(code);
      const firstLine = stderr.split("\n")[0] ?? `rg exited with code ${codeText}`;
      if (/regex parse error|unclosed character class|repetition operator missing/i.test(stderr)) {
        finishWithError("bad_pattern", firstLine);
        return;
      }
      finishWithError("io", firstLine);
    });
  });
}

function drainRipgrepLines(buffer: string, onLine: (line: string) => boolean): LineDrainResult {
  let remaining = buffer;
  let newlineIndex = remaining.indexOf("\n");

  while (newlineIndex >= 0) {
    const line = remaining.slice(0, newlineIndex);
    remaining = remaining.slice(newlineIndex + 1);
    if (line && !onLine(line)) {
      return { buffer: remaining, stopped: true };
    }
    newlineIndex = remaining.indexOf("\n");
  }

  return { buffer: remaining, stopped: false };
}

function collectLineResult<Result>(
  line: string,
  options: RipgrepCollectOptions<Result>,
): Result | null {
  const match = parseRipgrepMatch(line, options.worktreeRoot);
  return match
    ? maybeCollectMatch(match, options.gitignoreCache, options.worktreeRoot, options.toResult)
    : null;
}

function maybeCollectMatch<Result>(
  match: RipgrepMatch,
  gitignoreCache: Map<string, IgnoreManager | null> | null,
  worktreeRoot: string,
  toResult: (match: RipgrepMatch) => Result | null,
): Result | null {
  if (gitignoreCache && isIgnoredByGitignores(match.absPath, worktreeRoot, gitignoreCache)) {
    return null;
  }
  return toResult(match);
}
