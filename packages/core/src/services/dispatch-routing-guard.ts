import { execFile as execFileCb } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ResolvedProjectEntry } from "../projects/schema.js";

const execFile = promisify(execFileCb);

const GIT_LOOKUP_TIMEOUT_MS = 2_000;

export type DispatchRoutingGuardInput = {
  prompt: string;
  project_id: string;
  registry: ResolvedProjectEntry[];
  branch_base?: string;
};

export type DispatchRoutingGuardResult =
  | { status: "ok"; mentioned_paths: string[] }
  | {
      status: "mismatch";
      mentioned_paths: string[];
      missing_in_project: string[];
      suggested_project_id?: string;
    };

interface AbsoluteMentionAnalysis {
  absoluteProjectMentions: Map<string, number>;
  sawCurrentProjectPath: boolean;
  ambiguousAbsoluteMentions: number;
}

function analyzeAbsoluteMentions(
  absoluteMentions: string[],
  input: DispatchRoutingGuardInput,
): AbsoluteMentionAnalysis {
  const absoluteProjectMentions = new Map<string, number>();
  let sawCurrentProjectPath = false;
  let ambiguousAbsoluteMentions = 0;
  for (const abs of absoluteMentions) {
    const projectResolution = resolveProjectIdFromAbsolutePath(abs, input.registry);
    if (projectResolution.status === "none") continue;
    if (projectResolution.status === "ambiguous") {
      ambiguousAbsoluteMentions += 1;
      continue;
    }
    if (projectResolution.project_id === input.project_id) {
      sawCurrentProjectPath = true;
      continue;
    }
    absoluteProjectMentions.set(
      projectResolution.project_id,
      (absoluteProjectMentions.get(projectResolution.project_id) ?? 0) + 1,
    );
  }
  return { absoluteProjectMentions, sawCurrentProjectPath, ambiguousAbsoluteMentions };
}

function resolveAbsoluteMismatch(
  mentioned_paths: string[],
  analysis: AbsoluteMentionAnalysis,
): DispatchRoutingGuardResult | null {
  const { absoluteProjectMentions, sawCurrentProjectPath, ambiguousAbsoluteMentions } = analysis;
  if (absoluteProjectMentions.size > 0 && sawCurrentProjectPath) {
    return { status: "mismatch", mentioned_paths, missing_in_project: [] };
  }
  if (absoluteProjectMentions.size > 0) {
    return {
      status: "mismatch",
      mentioned_paths,
      missing_in_project: [],
      suggested_project_id: pickMostFrequentProject(absoluteProjectMentions),
    };
  }
  if (ambiguousAbsoluteMentions > 0) {
    return { status: "mismatch", mentioned_paths, missing_in_project: [] };
  }
  return null;
}

interface PackageMismatchAnalysis {
  missing_in_project: string[];
  suggestedCounts: Map<string, number>;
}

function collectSuggestionsForToken(
  token: string,
  input: DispatchRoutingGuardInput,
  memoizedExistsSync: (path: string) => boolean,
  suggestedCounts: Map<string, number>,
): void {
  for (const entry of input.registry) {
    if (entry.project_id === input.project_id) continue;
    if (memoizedExistsSync(join(entry.root_path, token))) {
      suggestedCounts.set(entry.project_id, (suggestedCounts.get(entry.project_id) ?? 0) + 1);
    }
  }
}

async function runGit(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: GIT_LOOKUP_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// The home checkout's working tree can lag the dispatch base or have already
// dropped a retired package, so a token absent on disk still belongs to the
// target when the target's git knows the path.
async function isKnownToProject(
  root: string,
  token: string,
  branchBase: string | undefined,
  memoizedExistsSync: (path: string) => boolean,
): Promise<boolean> {
  if (memoizedExistsSync(join(root, token))) return true;
  if (branchBase !== undefined) {
    const objectSpec = `${branchBase}:./${token}`;
    const atBase = await runGit(root, ["cat-file", "-e", "--end-of-options", objectSpec]);
    if (atBase !== null) return true;
  }
  const lastTouch = await runGit(root, ["rev-list", "-1", "--all", "--", token]);
  return lastTouch !== null && lastTouch !== "";
}

async function analyzePackageTokens(
  packageTokens: string[],
  input: DispatchRoutingGuardInput,
  currentRoot: string | undefined,
  memoizedExistsSync: (path: string) => boolean,
): Promise<PackageMismatchAnalysis> {
  const suggestedCounts = new Map<string, number>();
  if (currentRoot === undefined) return { missing_in_project: packageTokens, suggestedCounts };
  const known = await Promise.all(
    packageTokens.map((token) =>
      isKnownToProject(currentRoot, token, input.branch_base, memoizedExistsSync),
    ),
  );
  const missing_in_project: string[] = [];
  for (const [index, token] of packageTokens.entries()) {
    if (known[index] === true) continue;
    missing_in_project.push(token);
    collectSuggestionsForToken(token, input, memoizedExistsSync, suggestedCounts);
  }
  return { missing_in_project, suggestedCounts };
}

function makeMemoizedExists(existsSync: (p: string) => boolean): (path: string) => boolean {
  const existsCache = new Map<string, boolean>();
  return (path: string): boolean => {
    const cached = existsCache.get(path);
    if (cached !== undefined) return cached;
    const value = existsSync(path);
    existsCache.set(path, value);
    return value;
  };
}

export async function inspectPromptVsProject(
  input: DispatchRoutingGuardInput,
  opts?: { existsSync?: (p: string) => boolean },
): Promise<DispatchRoutingGuardResult> {
  const memoizedExistsSync = makeMemoizedExists(opts?.existsSync ?? defaultExistsSync);
  const mentioned_paths = collectMentionedPaths(input.prompt, input.registry);
  if (mentioned_paths.length === 0) return { status: "ok", mentioned_paths };

  const registryById = new Map(input.registry.map((entry) => [entry.project_id, entry] as const));
  const currentRoot = registryById.get(input.project_id)?.root_path;

  const absoluteMentions = mentioned_paths.filter((value) => value.startsWith("/"));
  const absoluteAnalysis = analyzeAbsoluteMentions(absoluteMentions, input);
  const absoluteResult = resolveAbsoluteMismatch(mentioned_paths, absoluteAnalysis);
  if (absoluteResult) return absoluteResult;

  const packageTokens = mentioned_paths.filter((value) => /^packages\/[A-Za-z0-9_-]+$/.test(value));
  if (packageTokens.length === 0) return { status: "ok", mentioned_paths };

  const { missing_in_project, suggestedCounts } = await analyzePackageTokens(
    packageTokens,
    input,
    currentRoot,
    memoizedExistsSync,
  );
  if (missing_in_project.length === 0) return { status: "ok", mentioned_paths };

  const result: DispatchRoutingGuardResult = {
    status: "mismatch",
    mentioned_paths,
    missing_in_project: dedupe(missing_in_project),
  };
  if (suggestedCounts.size > 0) {
    result.suggested_project_id = pickMostFrequentProject(suggestedCounts);
  }
  return result;
}

const PATH_TERMINATOR_RE = /[\s`'"]/;

function advancePathCursor(prompt: string, start: number): number {
  let cursor = start;
  while (cursor < prompt.length) {
    const char = prompt[cursor];
    if (char === undefined || PATH_TERMINATOR_RE.test(char)) break;
    cursor += 1;
  }
  return cursor;
}

function recordRootMatch(
  prompt: string,
  root: string,
  start: number,
  mentioned: string[],
  seen: Set<string>,
): void {
  const end = start + root.length;
  const nextChar = prompt[end];
  if (nextChar !== undefined && nextChar !== "/" && !PATH_TERMINATOR_RE.test(nextChar)) return;
  const cursor = advancePathCursor(prompt, end);
  const path = prompt.slice(start, cursor);
  if (!seen.has(path)) {
    seen.add(path);
    mentioned.push(path);
  }
}

function collectRootMatches(
  prompt: string,
  root: string,
  mentioned: string[],
  seen: Set<string>,
): void {
  const rootRe = new RegExp(escapeRegExp(root), "g");
  for (const match of prompt.matchAll(rootRe)) {
    const start = match.index;
    if (start < 0) continue;
    recordRootMatch(prompt, root, start, mentioned, seen);
  }
}

function collectPackageMatches(prompt: string, mentioned: string[], seen: Set<string>): void {
  const packageRe = /(?<![A-Za-z0-9._/-])packages\/[A-Za-z0-9_-]+/g;
  for (const match of prompt.matchAll(packageRe)) {
    const value = match[0];
    if (!seen.has(value)) {
      seen.add(value);
      mentioned.push(value);
    }
  }
}

export function collectMentionedPaths(prompt: string, registry: ResolvedProjectEntry[]): string[] {
  const mentioned: string[] = [];
  const seen = new Set<string>();
  for (const entry of registry) {
    for (const root of effectiveRoots(entry)) {
      collectRootMatches(prompt, root, mentioned, seen);
    }
  }
  collectPackageMatches(prompt, mentioned, seen);
  return mentioned;
}

export type ProjectIdResolution =
  | { status: "unique"; project_id: string }
  | { status: "ambiguous" }
  | { status: "none" };

interface ResolutionState {
  longestRootLength: number;
  winningProjectId: string | undefined;
  tiedProjectIds: Set<string>;
}

function updateResolutionForRoot(
  state: ResolutionState,
  path: string,
  root: string,
  projectId: string,
): void {
  if (path !== root && !path.startsWith(`${root}/`)) return;
  if (root.length > state.longestRootLength) {
    state.longestRootLength = root.length;
    state.winningProjectId = projectId;
    state.tiedProjectIds.clear();
    state.tiedProjectIds.add(projectId);
    return;
  }
  if (root.length === state.longestRootLength) {
    state.tiedProjectIds.add(projectId);
  }
}

export function resolveProjectIdFromAbsolutePath(
  path: string,
  registry: ResolvedProjectEntry[],
): ProjectIdResolution {
  const state: ResolutionState = {
    longestRootLength: -1,
    winningProjectId: undefined,
    tiedProjectIds: new Set<string>(),
  };
  for (const entry of registry) {
    for (const root of effectiveRoots(entry)) {
      updateResolutionForRoot(state, path, root, entry.project_id);
    }
  }
  if (state.winningProjectId === undefined) return { status: "none" };
  if (state.tiedProjectIds.size > 1) return { status: "ambiguous" };
  return { status: "unique", project_id: state.winningProjectId };
}

function pickMostFrequentProject(counts: Map<string, number>): string | undefined {
  let bestProject: string | undefined;
  let bestCount = -1;
  for (const [projectId, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestProject = projectId;
    }
  }
  return bestProject;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function effectiveRoots(entry: ResolvedProjectEntry): string[] {
  if (entry.canonical_root_path && entry.canonical_root_path !== entry.root_path) {
    return [entry.root_path, entry.canonical_root_path];
  }
  return [entry.root_path];
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
