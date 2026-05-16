import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistryFileSchema, type ProjectEntry } from './schema.js';
export { getGithubRepo } from './schema.js';

const missingWarnings = new Set<string>();

export class ProjectRegistryParseError extends Error {
  constructor(
    path: string,
    cause: unknown,
  ) {
    super(`project registry ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ProjectRegistryParseError';
  }
}

export class ProjectRegistryDuplicateId extends Error {
  readonly id: string;

  constructor(id: string, filePath: string) {
    super(`project registry ${filePath}: duplicate project_id ${id}`);
    this.name = 'ProjectRegistryDuplicateId';
    this.id = id;
  }
}

export class ProjectRegistry {
  #entries: Map<string, ProjectEntry>;

  constructor(entries: Map<string, ProjectEntry>) {
    this.#entries = entries;
    Object.freeze(this);
  }

  get(project_id: string): ProjectEntry | undefined {
    return this.#entries.get(project_id);
  }

  has(project_id: string): boolean {
    return this.#entries.has(project_id);
  }

  list(): ProjectEntry[] {
    return [...this.#entries.values()];
  }
}

export function defaultProjectRegistryPath(): string {
  return join(homedir(), '.penumbra/projects.yaml');
}

export function loadProjectRegistry(filePath = defaultProjectRegistryPath()): ProjectRegistry {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseProjectRegistryYaml(raw);
    const file = ProjectRegistryFileSchema.parse(parsed);
    const entries = new Map<string, ProjectEntry>();

    for (const entry of file.projects) {
      if (entry.remote && entry.gh_repo) {
        throw new Error(`entry ${entry.project_id} declares both legacy gh_repo and remote; pick one`);
      }
      if (entries.has(entry.project_id)) {
        throw new ProjectRegistryDuplicateId(entry.project_id, filePath);
      }
      entries.set(entry.project_id, entry);
    }

    return new ProjectRegistry(Object.freeze(entries));
  } catch (err) {
    if (isMissingFileError(err)) {
      if (!missingWarnings.has(filePath)) {
        missingWarnings.add(filePath);
        console.warn(`project registry ${filePath} not found; continuing without project registry`);
      }
      return new ProjectRegistry(Object.freeze(new Map<string, ProjectEntry>()));
    }
    if (err instanceof ProjectRegistryDuplicateId) {
      throw err;
    }
    throw new ProjectRegistryParseError(filePath, err);
  }
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

function parseProjectRegistryYaml(raw: string): unknown {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const projectsIndex = lines.findIndex((line) => line.trim() === 'projects:');
  if (projectsIndex < 0) {
    throw new Error('missing projects root key');
  }

  const entries: ProjectEntry[] = [];
  let current: Partial<ProjectEntry> | null = null;
  let sawEntry = false;

  for (let i = projectsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;

    const entryMatch = line.match(/^\s*-\s+project_id:\s*(.+)\s*$/);
    if (entryMatch) {
      if (current && current.project_id && current.root_path) {
        entries.push(current as ProjectEntry);
      } else if (current) {
        throw new Error('incomplete project entry');
      }
      current = { project_id: unquote(entryMatch[1]!) };
      sawEntry = true;
      continue;
    }

    const projectIdMatch = line.match(/^\s*project_id:\s*(.+)\s*$/);
    if (projectIdMatch) {
      if (!current) current = {};
      current.project_id = unquote(projectIdMatch[1]!);
      continue;
    }

    const rootPathMatch = line.match(/^\s*root_path:\s*(.+)\s*$/);
    if (rootPathMatch) {
      if (!current) current = {};
      current.root_path = unquote(rootPathMatch[1]!);
      continue;
    }

    const ghRepoMatch = line.match(/^\s*gh_repo:\s*(.+)\s*$/);
    if (ghRepoMatch) {
      if (!current) current = {};
      current.gh_repo = unquote(ghRepoMatch[1]!);
      continue;
    }

    const remoteKindMatch = line.match(/^\s*remote:\s*$/);
    if (remoteKindMatch) {
      const kindLine = lines[i + 1] ?? '';
      const repoLine = lines[i + 2] ?? '';
      const kindMatch = kindLine.match(/^\s+kind:\s*(.+)\s*$/);
      const repoMatch = repoLine.match(/^\s+repo:\s*(.+)\s*$/);
      if (!kindMatch || !repoMatch) {
        throw new Error('remote block must contain kind and repo');
      }
      const kind = unquote(kindMatch[1]!);
      if (kind !== 'github') {
        throw new Error(`unsupported remote kind: ${kind}`);
      }
      if (!current) current = {};
      current.remote = {
        kind: 'github',
        repo: unquote(repoMatch[1]!),
      };
      i += 2;
      continue;
    }

    throw new Error(`unrecognized registry yaml line: ${line}`);
  }

  if (current) {
    if (!current.project_id || !current.root_path) {
      throw new Error('incomplete project entry');
    }
    entries.push(current as ProjectEntry);
  }

  if (!sawEntry && entries.length === 0) {
    throw new Error('no project entries found');
  }

  return { projects: entries };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
