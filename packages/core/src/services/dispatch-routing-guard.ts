import { existsSync as defaultExistsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectEntry } from '../projects/schema.js';

export type DispatchRoutingGuardInput = {
  prompt: string;
  project_id: string;
  registry: ProjectEntry[];
};

export type DispatchRoutingGuardResult =
  | { status: 'ok'; mentioned_paths: string[] }
  | {
      status: 'mismatch';
      mentioned_paths: string[];
      missing_in_project: string[];
      suggested_project_id?: string;
    };

export function inspectPromptVsProject(
  input: DispatchRoutingGuardInput,
  opts?: { existsSync?: (p: string) => boolean },
): DispatchRoutingGuardResult {
  const existsSync = opts?.existsSync ?? defaultExistsSync;
  const mentioned_paths = collectMentionedPaths(input.prompt);
  if (mentioned_paths.length === 0) {
    return { status: 'ok', mentioned_paths };
  }

  const registryById = new Map(input.registry.map((entry) => [entry.project_id, entry] as const));
  const currentProject = registryById.get(input.project_id);
  const currentRoot = currentProject?.root_path;

  const absoluteMentions = mentioned_paths.filter((value) => value.startsWith('/'));
  const absoluteProjectMentions = new Map<string, number>();
  let sawCurrentProjectPath = false;
  for (const abs of absoluteMentions) {
    const projectId = resolveProjectIdFromAbsolutePath(abs, input.registry);
    if (!projectId) continue;
    if (projectId === input.project_id) {
      sawCurrentProjectPath = true;
      continue;
    }
    absoluteProjectMentions.set(projectId, (absoluteProjectMentions.get(projectId) ?? 0) + 1);
  }
  if (absoluteProjectMentions.size > 0 && sawCurrentProjectPath) {
    return {
      status: 'mismatch',
      mentioned_paths,
      missing_in_project: [],
    };
  }
  if (absoluteProjectMentions.size > 0) {
    return {
      status: 'mismatch',
      mentioned_paths,
      missing_in_project: [],
      suggested_project_id: pickMostFrequentProject(absoluteProjectMentions),
    };
  }

  const packageTokens = mentioned_paths.filter((value) => /^packages\/[A-Za-z0-9_-]+$/.test(value));
  if (packageTokens.length === 0) {
    return { status: 'ok', mentioned_paths };
  }
  const missing_in_project: string[] = [];
  const suggestedCounts = new Map<string, number>();
  for (const token of packageTokens) {
    if (!currentRoot) {
      missing_in_project.push(token);
      continue;
    }
    const currentPath = join(currentRoot, token);
    if (existsSync(currentPath)) continue;
    missing_in_project.push(token);
    for (const entry of input.registry) {
      if (entry.project_id === input.project_id) continue;
      if (existsSync(join(entry.root_path, token))) {
        suggestedCounts.set(entry.project_id, (suggestedCounts.get(entry.project_id) ?? 0) + 1);
      }
    }
  }

  if (missing_in_project.length === 0) {
    return { status: 'ok', mentioned_paths };
  }

  const result: DispatchRoutingGuardResult = {
    status: 'mismatch',
    mentioned_paths,
    missing_in_project: dedupe(missing_in_project),
  };
  if (suggestedCounts.size > 0) {
    result.suggested_project_id = pickMostFrequentProject(suggestedCounts);
  }
  return result;
}

function collectMentionedPaths(prompt: string): string[] {
  const mentioned: string[] = [];
  const seen = new Set<string>();

  const absoluteRe = /\/(?:Volumes|Users|private)\/[^\s`'"]+/g;
  for (const match of prompt.matchAll(absoluteRe)) {
    const value = match[0];
    if (!seen.has(value)) {
      seen.add(value);
      mentioned.push(value);
    }
  }

  const packageRe = /(?<![A-Za-z0-9._/-])packages\/[A-Za-z0-9_-]+/g;
  for (const match of prompt.matchAll(packageRe)) {
    const value = match[0];
    if (!seen.has(value)) {
      seen.add(value);
      mentioned.push(value);
    }
  }

  return mentioned;
}

function resolveProjectIdFromAbsolutePath(path: string, registry: ProjectEntry[]): string | undefined {
  const resolved = registry.find((entry) => path === entry.root_path || path.startsWith(`${entry.root_path}/`));
  if (resolved) return resolved.project_id;
  const segments = path.split('/');
  const rootIndex = segments.indexOf('personal');
  const projectName = rootIndex >= 0 ? segments[rootIndex + 1] : undefined;
  if (!projectName) return undefined;
  return registry.find((entry) => entry.root_path.split('/').at(-1) === projectName)?.project_id;
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
