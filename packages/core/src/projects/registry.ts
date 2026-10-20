import { readFileSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  type ProjectEntry,
  ProjectRegistryFileSchema,
  type ResolvedProjectEntry,
} from "./schema.js";
export { getGithubRepo } from "./schema.js";

const { resolveOperatorConfigPath } = createRequire(import.meta.url)(
  "../../../config/src/files/operator-paths.js",
) as {
  resolveOperatorConfigPath: (filename: string, env: Record<string, string | undefined>) => string;
};

const missingWarnings = new Set<string>();
const canonicalizationWarnings = new Set<string>();

export class ProjectRegistryParseError extends Error {
  constructor(path: string, cause: unknown) {
    super(`project registry ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ProjectRegistryParseError";
  }
}

export class ProjectRegistryDuplicateId extends Error {
  readonly id: string;

  constructor(id: string, filePath: string) {
    super(`project registry ${filePath}: duplicate project_id ${id}`);
    this.name = "ProjectRegistryDuplicateId";
    this.id = id;
  }
}

export class ProjectRegistry {
  #entries: Map<string, ResolvedProjectEntry>;

  constructor(entries: Map<string, ResolvedProjectEntry>) {
    this.#entries = entries;
    Object.freeze(this);
  }

  get(project_id: string): ResolvedProjectEntry | undefined {
    return this.#entries.get(project_id);
  }

  has(project_id: string): boolean {
    return this.#entries.has(project_id);
  }

  list(): ResolvedProjectEntry[] {
    return [...this.#entries.values()];
  }

  get size(): number {
    return this.#entries.size;
  }
}

export function defaultProjectRegistryPath(): string {
  return resolveOperatorConfigPath("projects.yaml", process.env);
}

export function loadProjectRegistry(filePath = defaultProjectRegistryPath()): ProjectRegistry {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = parseProjectRegistryYaml(raw);
    const file = ProjectRegistryFileSchema.parse(parsed);
    const entries = buildResolvedEntries(file.projects, filePath);
    return new ProjectRegistry(Object.freeze(entries));
  } catch (err) {
    if (isMissingFileError(err)) {
      warnMissingRegistry(filePath);
      return new ProjectRegistry(Object.freeze(new Map<string, ResolvedProjectEntry>()));
    }
    if (err instanceof ProjectRegistryDuplicateId) {
      throw err;
    }
    throw new ProjectRegistryParseError(filePath, err);
  }
}

// Unlike loadProjectRegistry, a missing or unreadable file throws (the fs error
// propagates with its `code` intact) — callers decide whether ENOENT is benign.
export async function loadProjectRegistryAsync(
  filePath = defaultProjectRegistryPath(),
): Promise<ProjectRegistry> {
  const raw = await readFile(filePath, "utf8");
  try {
    const parsed = parseProjectRegistryYaml(raw);
    const file = ProjectRegistryFileSchema.parse(parsed);
    const entries = await buildResolvedEntriesAsync(file.projects, filePath);
    return new ProjectRegistry(Object.freeze(entries));
  } catch (err) {
    if (err instanceof ProjectRegistryDuplicateId) {
      throw err;
    }
    throw new ProjectRegistryParseError(filePath, err);
  }
}

function buildResolvedEntries(
  projects: ProjectEntry[],
  filePath: string,
): Map<string, ResolvedProjectEntry> {
  const entries = new Map<string, ResolvedProjectEntry>();
  for (const entry of projects) {
    if (entry.remote && entry.gh_repo) {
      throw new Error(
        `entry ${entry.project_id} declares both legacy gh_repo and remote; pick one`,
      );
    }
    if (entries.has(entry.project_id)) {
      throw new ProjectRegistryDuplicateId(entry.project_id, filePath);
    }
    const resolvedRoot = canonicalizeRoot(entry, filePath);
    entries.set(
      entry.project_id,
      resolvedRoot ? { ...entry, canonical_root_path: resolvedRoot } : entry,
    );
  }
  return entries;
}

async function buildResolvedEntriesAsync(
  projects: ProjectEntry[],
  filePath: string,
): Promise<Map<string, ResolvedProjectEntry>> {
  const resolved = await Promise.all(
    projects.map(async (entry) => {
      if (entry.remote && entry.gh_repo) {
        throw new Error(
          `entry ${entry.project_id} declares both legacy gh_repo and remote; pick one`,
        );
      }
      const resolvedRoot = await canonicalizeRootAsync(entry, filePath);
      return resolvedRoot ? { ...entry, canonical_root_path: resolvedRoot } : entry;
    }),
  );
  const entries = new Map<string, ResolvedProjectEntry>();
  for (const entry of resolved) {
    if (entries.has(entry.project_id)) {
      throw new ProjectRegistryDuplicateId(entry.project_id, filePath);
    }
    entries.set(entry.project_id, entry);
  }
  return entries;
}

async function canonicalizeRootAsync(
  entry: ProjectEntry,
  filePath: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(entry.root_path);
    return resolved !== entry.root_path ? resolved : undefined;
  } catch (err) {
    warnCanonicalizationFailure(entry, filePath, err);
    return undefined;
  }
}

function canonicalizeRoot(entry: ProjectEntry, filePath: string): string | undefined {
  try {
    const resolved = realpathSync(entry.root_path);
    return resolved !== entry.root_path ? resolved : undefined;
  } catch (err) {
    warnCanonicalizationFailure(entry, filePath, err);
    return undefined;
  }
}

function warnCanonicalizationFailure(entry: ProjectEntry, filePath: string, err: unknown): void {
  const warningKey = `${filePath}\0${entry.project_id}\0${entry.root_path}`;
  if (canonicalizationWarnings.has(warningKey)) return;
  if (canonicalizationWarnings.size >= 256) canonicalizationWarnings.clear();
  canonicalizationWarnings.add(warningKey);
  const detail =
    (err as { code?: string } | null)?.code ?? (err instanceof Error ? err.message : String(err));
  console.warn(
    `project registry ${sanitizeLogValue(filePath)}: canonicalization failed for project_id=${sanitizeLogValue(entry.project_id)} root=${sanitizeLogValue(entry.root_path)}: ${sanitizeLogValue(detail)}`,
  );
}

function warnMissingRegistry(filePath: string): void {
  if (missingWarnings.has(filePath)) return;
  missingWarnings.add(filePath);
  console.warn(
    `project registry ${sanitizeLogValue(filePath)} not found; continuing without project registry`,
  );
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
}

function sanitizeLogValue(value: string): string {
  const escaped = value.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  if (escaped.length <= 256) return escaped;
  return `${escaped.slice(0, 253)}...`;
}

const ENTRY_RE = /^\s*-\s+project_id:[ \t]*(\S.*)$/;
const PROJECT_ID_RE = /^\s*project_id:[ \t]*(\S.*)$/;
const ROOT_PATH_RE = /^\s*root_path:[ \t]*(\S.*)$/;
const GH_REPO_RE = /^\s*gh_repo:[ \t]*(\S.*)$/;
const REMOTE_BLOCK_RE = /^\s*remote:\s*$/;
const DREAMING_BLOCK_RE = /^\s*dreaming:\s*$/;
const REMOTE_KIND_RE = /^\s+kind:[ \t]*(\S.*)$/;
const REMOTE_REPO_RE = /^\s+repo:[ \t]*(\S.*)$/;
const RESEARCH_PROVIDER_RE = /^\s+research_provider:[ \t]*(\S.*)$/;
const ALLOWED_DOMAINS_RE = /^\s+allowed_domains:\s*$/;
const DOMAIN_ITEM_RE = /^\s+-[ \t]*(\S.*)$/;
const COMMENT_RE = /^\s*#/;
const INDENT_RE = /^(\s*)/;

function parseProjectRegistryYaml(raw: string): unknown {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  const projectsIndex = lines.findIndex((line) => line.trim() === "projects:");
  if (projectsIndex < 0) throw new Error("missing projects root key");

  const state: ParserState = { entries: [], current: null, sawEntry: false };

  for (let i = projectsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim() || COMMENT_RE.test(line)) continue;
    i = dispatchLine(line, i, lines, state);
  }

  finalizeParserState(state);
  return { projects: state.entries };
}

interface ParserState {
  entries: ProjectEntry[];
  current: Partial<ProjectEntry> | null;
  sawEntry: boolean;
}

function dispatchLine(line: string, i: number, lines: string[], state: ParserState): number {
  if (tryApplyScalarLine(line, state)) return i;

  if (REMOTE_BLOCK_RE.test(line)) {
    const consumed = parseRemoteBlock(lines, i + 1, state);
    return i + consumed;
  }

  if (DREAMING_BLOCK_RE.test(line)) {
    const consumed = parseDreamingBlock(line, lines, i + 1, state);
    return i + consumed;
  }

  throw new Error(`unrecognized registry yaml line: ${line}`);
}

function tryApplyScalarLine(line: string, state: ParserState): boolean {
  const entryMatch = ENTRY_RE.exec(line);
  if (entryMatch) {
    flushCurrentEntry(state);
    state.current = { project_id: unquote(entryMatch[1] ?? "") };
    state.sawEntry = true;
    return true;
  }

  const projectIdMatch = PROJECT_ID_RE.exec(line);
  if (projectIdMatch) {
    state.current ??= {};
    state.current.project_id = unquote(projectIdMatch[1] ?? "");
    return true;
  }

  const rootPathMatch = ROOT_PATH_RE.exec(line);
  if (rootPathMatch) {
    state.current ??= {};
    state.current.root_path = unquote(rootPathMatch[1] ?? "");
    return true;
  }

  const ghRepoMatch = GH_REPO_RE.exec(line);
  if (ghRepoMatch) {
    state.current ??= {};
    state.current.gh_repo = unquote(ghRepoMatch[1] ?? "");
    return true;
  }

  return false;
}

function flushCurrentEntry(state: ParserState): void {
  if (state.current?.project_id && state.current.root_path) {
    state.entries.push(state.current as ProjectEntry);
  } else if (state.current) {
    throw new Error("incomplete project entry");
  }
}

function parseRemoteBlock(lines: string[], start: number, state: ParserState): number {
  let kind: string | undefined;
  let repo: string | undefined;
  let consumed = 0;
  let j = start;

  while (j < lines.length) {
    const remoteLine = lines[j] ?? "";
    if (!remoteLine.trim() || COMMENT_RE.test(remoteLine)) {
      j += 1;
      consumed += 1;
      continue;
    }
    const kindMatch = REMOTE_KIND_RE.exec(remoteLine);
    if (kindMatch) {
      kind = unquote(kindMatch[1] ?? "");
      j += 1;
      consumed += 1;
      continue;
    }
    const repoMatch = REMOTE_REPO_RE.exec(remoteLine);
    if (repoMatch) {
      repo = unquote(repoMatch[1] ?? "");
      j += 1;
      consumed += 1;
      continue;
    }
    break;
  }

  if (kind === undefined || repo === undefined) {
    throw new Error("remote block must contain kind and repo");
  }
  if (kind !== "github") throw new Error(`unsupported remote kind: ${kind}`);
  state.current ??= {};
  state.current.remote = { kind: "github", repo };
  return consumed;
}

interface DreamingFields {
  researchProvider?: "firecrawl" | "webfetch" | "off";
  allowedDomains?: string[];
}

function parseDreamingBlock(
  blockLine: string,
  lines: string[],
  start: number,
  state: ParserState,
): number {
  const dreamingIndent = INDENT_RE.exec(blockLine)?.[1]?.length ?? 0;
  const fields: DreamingFields = {};
  let consumed = 0;
  let j = start;

  while (j < lines.length) {
    const dreamingLine = lines[j] ?? "";
    if (!dreamingLine.trim() || COMMENT_RE.test(dreamingLine)) {
      j += 1;
      consumed += 1;
      continue;
    }
    if (indentOf(dreamingLine) <= dreamingIndent) break;
    const advance = applyDreamingLine(dreamingLine, lines, j, fields);
    if (advance === null) break;
    consumed += advance;
    j += advance;
  }

  state.current ??= {};
  applyDreamingFields(state.current, fields);
  return consumed;
}

function applyDreamingLine(
  dreamingLine: string,
  lines: string[],
  j: number,
  fields: DreamingFields,
): number | null {
  const researchProviderMatch = RESEARCH_PROVIDER_RE.exec(dreamingLine);
  if (researchProviderMatch) {
    fields.researchProvider = parseResearchProvider(researchProviderMatch[1] ?? "");
    return 1;
  }
  if (ALLOWED_DOMAINS_RE.test(dreamingLine)) {
    const result = parseAllowedDomains(dreamingLine, lines, j + 1);
    if (result.domains.length > 0) fields.allowedDomains = result.domains;
    return 1 + result.consumed;
  }
  return null;
}

function applyDreamingFields(current: Partial<ProjectEntry>, fields: DreamingFields): void {
  if (fields.researchProvider === undefined && fields.allowedDomains === undefined) return;
  current.dreaming = {
    ...(fields.allowedDomains !== undefined ? { allowed_domains: fields.allowedDomains } : {}),
    ...(fields.researchProvider !== undefined
      ? { research_provider: fields.researchProvider }
      : {}),
  };
}

function parseResearchProvider(raw: string): "firecrawl" | "webfetch" | "off" {
  const parsed = unquote(raw);
  if (parsed !== "firecrawl" && parsed !== "webfetch" && parsed !== "off") {
    throw new Error(`unsupported dreaming research_provider: ${parsed}`);
  }
  return parsed;
}

function parseAllowedDomains(
  headerLine: string,
  lines: string[],
  start: number,
): { domains: string[]; consumed: number } {
  const headerIndent = indentOf(headerLine);
  const domains: string[] = [];
  let consumed = 0;
  let j = start;

  while (j < lines.length) {
    const domainLine = lines[j] ?? "";
    if (!domainLine.trim() || COMMENT_RE.test(domainLine)) {
      j += 1;
      consumed += 1;
      continue;
    }
    if (indentOf(domainLine) <= headerIndent) break;

    const domainMatch = DOMAIN_ITEM_RE.exec(domainLine);
    if (!domainMatch) break;
    domains.push(unquote(domainMatch[1] ?? ""));
    j += 1;
    consumed += 1;
  }
  return { domains, consumed };
}

function indentOf(s: string): number {
  if (!s.trim()) return Number.MAX_SAFE_INTEGER;
  return INDENT_RE.exec(s)?.[1]?.length ?? 0;
}

function finalizeParserState(state: ParserState): void {
  if (state.current) {
    if (!state.current.project_id || !state.current.root_path) {
      throw new Error("incomplete project entry");
    }
    state.entries.push(state.current as ProjectEntry);
  }
  if (!state.sawEntry && state.entries.length === 0) {
    throw new Error("no project entries found");
  }
}

function unquote(value: string): string {
  const trimmed = stripTrailingInlineComment(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface InlineCommentState {
  inSingle: boolean;
  inDouble: boolean;
  escaped: boolean;
}

function stripTrailingInlineComment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const state: InlineCommentState = { inSingle: false, inDouble: false, escaped: false };
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (!ch) break;
    if (advanceQuoteState(state, ch)) continue;
    if (isInlineCommentStart(state, ch, trimmed, i)) {
      return trimmed.slice(0, i).trimEnd();
    }
  }
  return trimmed;
}

function advanceQuoteState(state: InlineCommentState, ch: string): boolean {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (state.inDouble) return advanceDoubleQuoteState(state, ch);
  if (state.inSingle) return advanceSingleQuoteState(state, ch);
  if (ch === "'") {
    state.inSingle = true;
    return true;
  }
  if (ch === '"') {
    state.inDouble = true;
    return true;
  }
  return false;
}

function advanceDoubleQuoteState(state: InlineCommentState, ch: string): boolean {
  if (ch === "\\") {
    state.escaped = true;
    return true;
  }
  if (ch === '"') {
    state.inDouble = false;
    return true;
  }
  return true;
}

function advanceSingleQuoteState(state: InlineCommentState, ch: string): boolean {
  if (ch === "'") {
    state.inSingle = false;
  }
  return true;
}

function isInlineCommentStart(
  state: InlineCommentState,
  ch: string,
  trimmed: string,
  i: number,
): boolean {
  return (
    ch === "#" && !state.inSingle && !state.inDouble && (i === 0 || /\s/.test(trimmed[i - 1] ?? ""))
  );
}
