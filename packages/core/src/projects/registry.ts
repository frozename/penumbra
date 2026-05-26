import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ProjectRegistryFileSchema, type ProjectEntry, type ResolvedProjectEntry } from './schema.js';
export { getGithubRepo } from './schema.js';

const { resolveOperatorConfigPath } = createRequire(import.meta.url)(
  '../../../config/src/files/operator-paths.js',
) as {
  resolveOperatorConfigPath: (filename: string, env: Record<string, string | undefined>) => string;
};

const missingWarnings = new Set<string>();
const canonicalizationWarnings = new Set<string>();

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
}

export function defaultProjectRegistryPath(): string {
  return resolveOperatorConfigPath('projects.yaml', process.env);
}

export function loadProjectRegistry(filePath = defaultProjectRegistryPath()): ProjectRegistry {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseProjectRegistryYaml(raw);
    const file = ProjectRegistryFileSchema.parse(parsed);
    const entries = new Map<string, ResolvedProjectEntry>();

    for (const entry of file.projects) {
      if (entry.remote && entry.gh_repo) {
        throw new Error(`entry ${entry.project_id} declares both legacy gh_repo and remote; pick one`);
      }
      if (entries.has(entry.project_id)) {
        throw new ProjectRegistryDuplicateId(entry.project_id, filePath);
      }
      let resolvedRoot: string | undefined;
      try {
        const resolved = realpathSync(entry.root_path);
        if (resolved !== entry.root_path) resolvedRoot = resolved;
      } catch (err) {
        const warningKey = `${filePath}\0${entry.project_id}\0${entry.root_path}`;
        if (!canonicalizationWarnings.has(warningKey)) {
          if (canonicalizationWarnings.size >= 256) {
            canonicalizationWarnings.clear();
          }
          canonicalizationWarnings.add(warningKey);
          console.warn(
            `project registry ${sanitizeLogValue(filePath)}: canonicalization failed for project_id=${sanitizeLogValue(entry.project_id)} root=${sanitizeLogValue(entry.root_path)}: ${sanitizeLogValue((err as { code?: string } | null)?.code ?? (err instanceof Error ? err.message : String(err)))}`,
          );
        }
      }
      entries.set(
        entry.project_id,
        resolvedRoot ? { ...entry, canonical_root_path: resolvedRoot } : entry,
      );
    }

    return new ProjectRegistry(Object.freeze(entries));
  } catch (err) {
    if (isMissingFileError(err)) {
      if (!missingWarnings.has(filePath)) {
        missingWarnings.add(filePath);
        console.warn(`project registry ${sanitizeLogValue(filePath)} not found; continuing without project registry`);
      }
      return new ProjectRegistry(Object.freeze(new Map<string, ResolvedProjectEntry>()));
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

function sanitizeLogValue(value: string): string {
  const escaped = value.replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
  if (escaped.length <= 256) return escaped;
  return `${escaped.slice(0, 253)}...`;
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
      let kind: string | undefined;
      let repo: string | undefined;
      let j = i + 1;
      let consumed = 0;

      while (j < lines.length) {
        const remoteLine = lines[j] ?? '';
        if (!remoteLine.trim() || /^\s*#/.test(remoteLine)) {
          j += 1;
          consumed += 1;
          continue;
        }

        const kindMatch = remoteLine.match(/^\s+kind:\s*(.+)\s*$/);
        if (kindMatch) {
          kind = unquote(kindMatch[1]!);
          j += 1;
          consumed += 1;
          continue;
        }

        const repoMatch = remoteLine.match(/^\s+repo:\s*(.+)\s*$/);
        if (repoMatch) {
          repo = unquote(repoMatch[1]!);
          j += 1;
          consumed += 1;
          continue;
        }

        break;
      }

      if (kind === undefined || repo === undefined) {
        throw new Error('remote block must contain kind and repo');
      }
      if (kind !== 'github') {
        throw new Error(`unsupported remote kind: ${kind}`);
      }
      if (!current) current = {};
      current.remote = {
        kind: 'github',
        repo,
      };
      i += consumed;
      continue;
    }

    const dreamingMatch = line.match(/^\s*dreaming:\s*$/);
    if (dreamingMatch) {
      // Indent of the `dreaming:` line itself. Nested keys + list items must
      // have strictly deeper indent; anything at or shallower than this
      // belongs to the parent / sibling entry (e.g. the next `  - project_id:`).
      const dreamingIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      const indentOf = (s: string): number => {
        if (!s.trim()) return Number.MAX_SAFE_INTEGER; // blank lines don't end the block
        return s.match(/^(\s*)/)?.[1]?.length ?? 0;
      };

      let researchProvider: 'firecrawl' | 'webfetch' | 'off' | undefined;
      let allowedDomains: string[] | undefined;
      let j = i + 1;
      let consumed = 0;

      while (j < lines.length) {
        const dreamingLine = lines[j] ?? '';
        if (!dreamingLine.trim() || /^\s*#/.test(dreamingLine)) {
          j += 1;
          consumed += 1;
          continue;
        }

        if (indentOf(dreamingLine) <= dreamingIndent) break;

        const researchProviderMatch = dreamingLine.match(/^\s+research_provider:\s*(.+)\s*$/);
        if (researchProviderMatch) {
          const parsedResearchProvider = unquote(researchProviderMatch[1]!);
          if (
            parsedResearchProvider !== 'firecrawl'
            && parsedResearchProvider !== 'webfetch'
            && parsedResearchProvider !== 'off'
          ) {
            throw new Error(`unsupported dreaming research_provider: ${parsedResearchProvider}`);
          }
          researchProvider = parsedResearchProvider;
          j += 1;
          consumed += 1;
          continue;
        }

        const allowedDomainsMatch = dreamingLine.match(/^\s+allowed_domains:\s*$/);
        if (allowedDomainsMatch) {
          const allowedDomainsIndent = indentOf(dreamingLine);
          const domains: string[] = [];
          j += 1;
          consumed += 1;

          while (j < lines.length) {
            const domainLine = lines[j] ?? '';
            if (!domainLine.trim() || /^\s*#/.test(domainLine)) {
              j += 1;
              consumed += 1;
              continue;
            }

            if (indentOf(domainLine) <= allowedDomainsIndent) break;

            const domainMatch = domainLine.match(/^\s+-\s*(.+)\s*$/);
            if (domainMatch) {
              domains.push(unquote(domainMatch[1]!));
              j += 1;
              consumed += 1;
              continue;
            }
            break;
          }

          if (domains.length > 0) {
            allowedDomains = domains;
          }
          continue;
        }

        break;
      }

      if (!current) current = {};
      if (researchProvider !== undefined || allowedDomains !== undefined) {
        current.dreaming = {
          ...(allowedDomains !== undefined ? { allowed_domains: allowedDomains } : {}),
          ...(researchProvider !== undefined ? { research_provider: researchProvider } : {}),
        };
      }
      i += consumed;
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
  const trimmed = stripTrailingInlineComment(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripTrailingInlineComment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (!ch) break;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inDouble && ch === '\\') {
      escaped = true;
      continue;
    }

    if (!inDouble && ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (inSingle && ch === "'") {
      inSingle = false;
      continue;
    }

    if (!inSingle && ch === '"' && !inDouble) {
      inDouble = true;
      continue;
    }
    if (inDouble && ch === '"') {
      inDouble = false;
      continue;
    }

    if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(trimmed[i - 1]!))) {
      return trimmed.slice(0, i).trimEnd();
    }
  }

  return trimmed;
}
