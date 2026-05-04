import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { parsePlanMetaFile } from '../../../workflows/src/plan-meta/parser.js';
import { validatePlan } from '../../../workflows/src/plan-meta/validator.js';

const FALLBACK_AGENTS: string[] = [
  'codex-acp-fast',
  'claude-acp-sonnet',
  'claude-acp-haiku',
  'gemini-acp',
  'opencode-acp',
];

export type Out = (s: string) => void;

export function findRepoRoot(startPath: string): string {
  const absolute = isAbsolute(startPath) ? startPath : resolve(process.cwd(), startPath);
  let current = existsSync(absolute) ? absolute : dirname(absolute);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export async function loadKnownAgents(repoRoot: string, warn: Out): Promise<Set<string>> {
  const yamlPath = join(repoRoot, 'agentchat.yaml');
  if (!existsSync(yamlPath)) {
    return new Set(FALLBACK_AGENTS);
  }
  try {
    const text = await readFile(yamlPath, 'utf8');
    const parsed = YAML.parse(text) as { agents?: Array<{ name?: unknown }> } | undefined;
    const names: string[] = [];
    if (parsed && Array.isArray(parsed.agents)) {
      for (const entry of parsed.agents) {
        if (entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.length > 0) {
          names.push(entry.name);
        }
      }
    }
    if (names.length === 0) {
      warn(`plan validate: agentchat.yaml at ${yamlPath} has no agents; using fallback registry`);
      return new Set(FALLBACK_AGENTS);
    }
    return new Set(names);
  } catch (err) {
    warn(`plan validate: failed to read agentchat.yaml (${err instanceof Error ? err.message : String(err)}); using fallback registry`);
    return new Set(FALLBACK_AGENTS);
  }
}

export interface RunPlanValidateOpts {
  path: string;
  repoRoot?: string;
  knownAgents?: Set<string>;
  out: Out;
  err: Out;
}

export async function runPlanValidate(opts: RunPlanValidateOpts): Promise<number> {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.path);
  const knownAgents = opts.knownAgents ?? (await loadKnownAgents(repoRoot, opts.err));

  const { tasks, errors } = await parsePlanMetaFile(opts.path);

  let hasIssue = false;

  if (errors.length > 0) {
    hasIssue = true;
    for (const e of errors) {
      opts.err(`parse: line ${e.line}: ${e.reason}`);
    }
  }

  if (tasks.length === 0 && errors.length === 0) {
    opts.err(`validate: no yaml meta blocks found in ${opts.path}`);
    return 2;
  }

  const validationErrors = await validatePlan(tasks, { repoRoot, knownAgents });
  if (validationErrors.length > 0) {
    hasIssue = true;
    for (const e of validationErrors) {
      opts.err(`${e.task_id}: ${e.rule}: ${e.message}`);
    }
  }

  if (hasIssue) return 2;
  return 0;
}

export async function dispatchPlanSubcommand(args: string[], _storageRoot: string): Promise<number> {
  const sub = args[0];
  const out = (s: string) => console.log(s);
  const err = (s: string) => console.error(s);
  switch (sub) {
    case 'validate': {
      const path = args[1];
      if (!path || path.startsWith('-')) {
        err('usage: penumbra plan validate <path>');
        return 2;
      }
      return runPlanValidate({ path, out, err });
    }
    default:
      err('usage: penumbra plan <validate>');
      return 2;
  }
}
