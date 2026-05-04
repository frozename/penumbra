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

/** Sentinels accepted in addition to whatever the registry returns. `maestro-inline`
 * marks tasks the maestro performs directly (smoke tests, research probes) — they
 * have no real agent backing them. */
const MAESTRO_SENTINELS: string[] = ['maestro-inline'];

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

async function loadFromDaemon(storageRoot: string): Promise<Set<string> | null> {
  try {
    const port = (await readFile(join(storageRoot, 'port'), 'utf8')).trim();
    const token = (await readFile(join(storageRoot, 'token'), 'utf8')).trim();
    if (!port || !token) return null;
    const r = await fetch(`http://127.0.0.1:${port}/chains/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { agents?: Array<{ name?: unknown }> };
    const names = (body.agents ?? [])
      .map((a) => (typeof a?.name === 'string' ? a.name : null))
      .filter((n): n is string => n != null && n.length > 0);
    return names.length > 0 ? new Set(names) : null;
  } catch {
    return null;
  }
}

async function loadFromYaml(repoRoot: string, warn: Out): Promise<Set<string> | null> {
  const yamlPath = join(repoRoot, 'agentchat.yaml');
  if (!existsSync(yamlPath)) return null;
  try {
    const text = await readFile(yamlPath, 'utf8');
    const parsed = YAML.parse(text) as { agents?: Array<{ name?: unknown }> } | undefined;
    const names = (parsed?.agents ?? [])
      .map((a) => (typeof a?.name === 'string' ? a.name : null))
      .filter((n): n is string => n != null && n.length > 0);
    return names.length > 0 ? new Set(names) : null;
  } catch (err) {
    warn(`plan validate: failed to read agentchat.yaml (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

export async function loadKnownAgents(repoRoot: string, warn: Out, storageRoot?: string): Promise<Set<string>> {
  let base: Set<string> | null = null;
  if (storageRoot) {
    base = await loadFromDaemon(storageRoot);
  }
  if (!base) base = await loadFromYaml(repoRoot, warn);
  if (!base) base = new Set(FALLBACK_AGENTS);
  for (const sentinel of MAESTRO_SENTINELS) base.add(sentinel);
  return base;
}

export interface RunPlanValidateOpts {
  path: string;
  repoRoot?: string;
  knownAgents?: Set<string>;
  storageRoot?: string;
  out: Out;
  err: Out;
}

export async function runPlanValidate(opts: RunPlanValidateOpts): Promise<number> {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.path);
  const knownAgents = opts.knownAgents ?? (await loadKnownAgents(repoRoot, opts.err, opts.storageRoot));

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

export async function dispatchPlanSubcommand(args: string[], storageRoot: string): Promise<number> {
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
      return runPlanValidate({ path, storageRoot, out, err });
    }
    default:
      err('usage: penumbra plan <validate>');
      return 2;
  }
}
