import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const ExtraWorkerSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'invalid extra worker id'),
  concurrency: z.number().int().positive().optional(),
  project_id: z.string().min(1).optional(),
  isolation: z.enum(['sticky', 'hard', 'shared']).optional(),
}).strict();

const ExtraWorkersConfigFileSchema = z.object({
  extras: z.array(ExtraWorkerSchema).default([]),
});

export type ExtraWorkerConfig = {
  id: string;
  concurrency: number;
  isolation: 'sticky' | 'hard' | 'shared';
  project_id?: string;
};

export type ExtraWorkersConfig = {
  extras: ExtraWorkerConfig[];
};

type ProjectRegistryLike = { has(id: string): boolean };

export class ExtraWorkersConfigError extends Error {
  constructor(message: string, public filePath: string) {
    super(`extra workers ${filePath}: ${message}`);
    this.name = 'ExtraWorkersConfigError';
  }
}

export interface ExtraWorkersConfigOptions {
  projectRegistry?: ProjectRegistryLike;
}

function readPrimaryWorkerId(): string | undefined {
  const home = process.env.HOME ?? homedir();
  const idPath = join(home, '.penumbra', 'worker-id');
  if (!existsSync(idPath)) return undefined;
  const raw = readFileSync(idPath, 'utf8');
  return raw.trim() || undefined;
}

export function loadExtraWorkersConfig(opts: ExtraWorkersConfigOptions = {}): ExtraWorkersConfig {
  const home = process.env.HOME ?? homedir();
  const path = process.env.PENUMBRA_WORKERS_CONFIG_PATH ?? join(home, '.penumbra', 'workers.yaml');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { extras: [] };
    }
    throw new ExtraWorkersConfigError(error instanceof Error ? error.message : String(error), path);
  }

  let parsed: unknown;
  try {
    parsed = parseExtraWorkersYaml(raw);
  } catch (error: unknown) {
    throw new ExtraWorkersConfigError(error instanceof Error ? error.message : String(error), path);
  }

  let file: { extras: Array<z.infer<typeof ExtraWorkerSchema>> };
  try {
    file = ExtraWorkersConfigFileSchema.parse(parsed) as { extras: Array<z.infer<typeof ExtraWorkerSchema>> };
  } catch (error: unknown) {
    throw new ExtraWorkersConfigError(error instanceof Error ? error.message : String(error), path);
  }
  const primaryWorkerId = readPrimaryWorkerId();
  const seen = new Set<string>();
  const extras: ExtraWorkerConfig[] = [];

  for (const extra of file.extras) {
    if (seen.has(extra.id)) {
      throw new ExtraWorkersConfigError(`duplicate extra worker id ${extra.id}`, path);
    }
    seen.add(extra.id);

    if (primaryWorkerId !== undefined && extra.id === primaryWorkerId) {
      throw new ExtraWorkersConfigError(`extra worker id ${extra.id} collides with primary worker id`, path);
    }

    const resolved: ExtraWorkerConfig = {
      id: extra.id,
      concurrency: extra.concurrency ?? 4,
      isolation: extra.isolation ?? (extra.project_id != null ? 'sticky' : 'shared'),
      project_id: extra.project_id,
    };

    if (resolved.project_id != null && opts.projectRegistry?.has(resolved.project_id) === false) {
      console.warn({
        event: 'extra_worker_unknown_project',
        worker_id: resolved.id,
        project_id: resolved.project_id,
      });
      continue;
    }

    extras.push(resolved);
  }

  return { extras };
}

function parseExtraWorkersYaml(raw: string): unknown {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const rootIndex = lines.findIndex((line) => line.trim() === 'extras:');
  if (rootIndex < 0) {
    throw new Error('missing extras root key');
  }

  const rootIndent = (lines[rootIndex]?.match(/^\s*/)?.[0]?.length ?? 0);
  const extras: Array<Record<string, string | number>> = [];
  let current: Record<string, string | number> | null = null;

  for (let i = rootIndex + 1; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) {
      continue;
    }

    const indent = rawLine.match(/^\s*/)?.[0]?.length ?? 0;
    if (indent <= rootIndent) {
      if (current !== null) {
        extras.push(current);
        current = null;
      }
      break;
    }

    const trimmed = rawLine.trim();
    const itemMatch = trimmed.match(/^-\s+([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (itemMatch) {
      if (current !== null) extras.push(current);
      const key = itemMatch[1]!;
      const value = itemMatch[2]!;
      current = { [key]: parseScalar(value) };
      continue;
    }

    if (trimmed.startsWith('-') && trimmed === '-') {
      if (current !== null) extras.push(current);
      current = {};
      continue;
    }

    if (current === null) {
      throw new Error('invalid worker entry');
    }

    const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!kvMatch) {
      throw new Error(`invalid worker entry line: ${trimmed}`);
    }
    current[kvMatch[1]!] = parseScalar(kvMatch[2]!);
  }

  if (current !== null) {
    extras.push(current);
  }

  return { extras };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value: string): string | number {
  const trimmed = value.trim();
  if (trimmed === '') return trimmed;
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }
  return unquote(trimmed);
}
