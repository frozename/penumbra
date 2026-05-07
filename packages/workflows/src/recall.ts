import type { Database } from 'bun:sqlite';
import type { RecallSource } from './schema.js';
import { runMemorySearchSource, type MemoryHit } from './recall-sources/memory.js';
import { runGitLog, runGitDiff } from './recall-sources/git.js';
import { runFsGlob } from './recall-sources/fs.js';
import { runDispatchEventsSource, type DispatchEvent } from './recall-sources/dispatch.js';
import { runHandoffPendingSource, type Handoff } from './recall-sources/handoff.js';
import { runAgentsSource } from './recall-sources/agents.js';
import { resolveTemplateVars, type TemplateVarContext } from './template-vars.js';

export type RecallBundle = {
  byKey: Record<string, unknown>;
  warnings: string[];
  estimatedTokens: number;
};

export type ComposeRecallOpts = {
  db: Database;
  embedder: { embed(texts: string[]): Promise<Float32Array[]> };
  cwd: string;
  project: string;
  sources: RecallSource[];
  budgetTokens?: number;
  agentRegistry?: { listAgents(): Array<{ name: string }> };
  templateCtx?: TemplateVarContext;
};

const DEFAULT_BUDGET = 8000;
const TOKEN_PER_CHAR = 0.25;

function estTokens(s: string): number {
  return Math.ceil(s.length * TOKEN_PER_CHAR);
}

function resolveArgs(args: Record<string, unknown>, ctx: TemplateVarContext | undefined): Record<string, unknown> {
  if (!ctx) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' ? resolveTemplateVars(v, ctx) : v;
  }
  return out;
}

function mergeBucket(bucket: Record<string, unknown>, key: string, value: unknown): void {
  const existing = bucket[key];
  if (existing === undefined) {
    bucket[key] = value;
    return;
  }
  if (Array.isArray(existing) && Array.isArray(value)) {
    bucket[key] = [...existing, ...value];
    return;
  }
  if (typeof existing === 'string' && typeof value === 'string') {
    bucket[key] = existing.length === 0 ? value : `${existing}\n${value}`;
    return;
  }
  bucket[key] = value;
}

export async function composeRecall(opts: ComposeRecallOpts): Promise<RecallBundle> {
  const { db, embedder, cwd, project, sources } = opts;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const byKey: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const src of sources) {
    const rawArgs = (('args' in src ? src.args : undefined) ?? {}) as Record<string, unknown>;
    const args = resolveArgs(rawArgs, opts.templateCtx);
    try {
      switch (src.source) {
        case 'memory.search': {
          const out = await runMemorySearchSource({
            db,
            embedder,
            args: { project, ...args } as never,
          });
          mergeBucket(byKey, 'memory.search', out.hits);
          warnings.push(...out.warnings);
          break;
        }
        case 'git.log': {
          const out = await runGitLog({ cwd, args: args as never });
          mergeBucket(byKey, 'git.log', out.text);
          warnings.push(...out.warnings);
          break;
        }
        case 'git.diff': {
          const out = await runGitDiff({ cwd, args: args as never });
          mergeBucket(byKey, 'git.diff', out.text);
          warnings.push(...out.warnings);
          break;
        }
        case 'fs.glob': {
          const out = await runFsGlob({ cwd, args: args as { pattern: string } });
          mergeBucket(byKey, 'fs.glob', out.matches);
          warnings.push(...out.warnings);
          break;
        }
        case 'dispatch_events': {
          const out = runDispatchEventsSource({ db, args: args as never });
          mergeBucket(byKey, 'dispatch_events', out.events);
          warnings.push(...out.warnings);
          break;
        }
        case 'handoff.list_pending': {
          const out = runHandoffPendingSource({ db, args: args as never });
          mergeBucket(byKey, 'handoff.list_pending', out.handoffs);
          warnings.push(...out.warnings);
          break;
        }
        case 'agents': {
          const out = runAgentsSource({ agentRegistry: opts.agentRegistry });
          mergeBucket(byKey, 'agents', out.agents);
          warnings.push(...out.warnings);
          break;
        }
        default:
          warnings.push(`unsupported source kind in MVP: ${src.source}`);
          byKey[src.source] = null;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`${src.source}: ${msg}`);
      byKey[src.source] = null;
    }
  }

  let total = 0;
  const sized: Array<{ key: string; ts: string; tokens: number; ref: unknown }> = [];

  for (const [key, val] of Object.entries(byKey)) {
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const item = val[i] as { ts?: string; created_at?: string };
        const tokens = estTokens(JSON.stringify(item));
        sized.push({ key, ts: item.ts ?? item.created_at ?? '', tokens, ref: item });
        total += tokens;
      }
    } else if (typeof val === 'string') {
      const tokens = estTokens(val);
      sized.push({ key, ts: '', tokens, ref: val });
      total += tokens;
    }
  }

  if (total > budget) {
    sized.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    const toDrop = new Set<unknown>();
    let cur = total;
    for (const s of sized) {
      if (cur <= budget) break;
      toDrop.add(s.ref);
      cur -= s.tokens;
    }
    for (const [key, val] of Object.entries(byKey)) {
      if (Array.isArray(val)) {
        byKey[key] = val.filter((v) => !toDrop.has(v));
      } else if (typeof val === 'string' && toDrop.has(val)) {
        byKey[key] = '';
      }
    }
    warnings.push(`recall budget exceeded: trimmed ${toDrop.size} items (target ${budget} tokens)`);
    total = cur;
  }

  return { byKey, warnings, estimatedTokens: total };
}

export type { MemoryHit, DispatchEvent, Handoff };
