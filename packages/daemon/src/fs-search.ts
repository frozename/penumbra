import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import ignoreFactory, { type Ignore as IgnoreManager } from "ignore";

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

async function readGitignore(dir: string): Promise<IgnoreManager | null> {
  try {
    const content = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    return (ignoreFactory as unknown as () => IgnoreManager)().add(content);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function rgBinary(): string {
  return process.env.PENUMBRA_RG_BINARY || "rg";
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

  while (slice.length > 0 && (slice[slice.length - 1]! & 0b1100_0000) === 0b1000_0000) {
    slice = slice.subarray(0, slice.length - 1);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (slice.length > 0) {
    try {
      return `${decoder.decode(slice)}…`;
    } catch {
      slice = slice.subarray(0, slice.length - 1);
      while (slice.length > 0 && (slice[slice.length - 1]! & 0b1100_0000) === 0b1000_0000) {
        slice = slice.subarray(0, slice.length - 1);
      }
    }
  }

  return "…";
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

  for (const rel of glob.scanSync({ cwd: searchRoot, onlyFiles: true, absolute: false })) {
    const abs = path.resolve(searchRoot, rel);
    const relFromWorktree = path.relative(worktreeRoot, abs);
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

  return await new Promise<GrepResult>((resolve, reject) => {
    const child = spawn(rgBinary(), rgArgs, { cwd: worktreeRoot });
    const results: GrepContentRow[] | string[] = [];
    const seenPaths = new Set<string>();
    let stderr = "";
    let buffer = "";
    let killed = false;
    let emitted = 0;

    const finishWithError = (
      code: "engine_unavailable" | "bad_pattern" | "io",
      message: string,
    ) => {
      reject(new GrepError(code, message));
    };

    child.on("error", (err: any) => {
      if (err?.code === "ENOENT") {
        finishWithError(
          "engine_unavailable",
          `ripgrep not found (binary: ${rgBinary()}). Set PENUMBRA_RG_BINARY or install ripgrep.`,
        );
        return;
      }
      finishWithError("io", err?.message ?? String(err));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (killed) return;
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }

          if (event?.type === "match") {
            const matchPath = event.data?.path?.text ?? "";
            if (!matchPath) {
              newlineIndex = buffer.indexOf("\n");
              continue;
            }
            const absPath = path.resolve(worktreeRoot, matchPath);
            const relPath = path.relative(worktreeRoot, absPath);
            if (gitignoreCache && isIgnoredByGitignores(absPath, worktreeRoot, gitignoreCache)) {
              newlineIndex = buffer.indexOf("\n");
              continue;
            }

            if (outputMode === "content") {
              emitted += 1;
              if (emitted > cap) {
                killed = true;
                child.kill();
                resolve({ results, truncated: true });
                return;
              }
              const text = (event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
              (results as GrepContentRow[]).push({
                path: relPath,
                line: event.data?.line_number ?? 0,
                text: capTextLine(text),
              });
            } else {
              if (seenPaths.has(relPath)) {
                newlineIndex = buffer.indexOf("\n");
                continue;
              }
              seenPaths.add(relPath);
              emitted += 1;
              if (emitted > cap) {
                killed = true;
                child.kill();
                resolve({ results, truncated: true });
                return;
              }
              (results as string[]).push(relPath);
            }
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
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

      const firstLine = stderr.split("\n")[0] || `rg exited with code ${code}`;
      if (/regex parse error|unclosed character class|repetition operator missing/i.test(stderr)) {
        finishWithError("bad_pattern", firstLine);
        return;
      }
      finishWithError("io", firstLine);
    });
  });
}
