import type { Database } from 'bun:sqlite';
import type { RecallSource } from './schema.js';
import { runMemorySearchSource, type MemoryHit } from './recall-sources/memory.js';
import { runGitLog, runGitDiff } from './recall-sources/git.js';
import { runFsGlob } from './recall-sources/fs.js';
import { runDispatchEventsSource, type DispatchEvent } from './recall-sources/dispatch.js';
import { runHandoffPendingSource, type Handoff } from './recall-sources/handoff.js';

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
};

const DEFAULT_BUDGET = 8000;
const TOKEN_PER_CHAR = 0.25;

function estTokens(s: string): number {
  return Math.ceil(s.length * TOKEN_PER_CHAR);
}

export async function composeRecall(opts: ComposeRecallOpts): Promise<RecallBundle> {
  const { db, embedder, cwd, project, sources } = opts;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const byKey: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const src of sources) {
    const args = (('args' in src ? src.args : undefined) ?? {}) as Record<string, unknown>;
    try {
      switch (src.source) {
        case 'memory.search': {
          const out = await runMemorySearchSource({
            db,
            embedder,
            args: { project, ...args } as never,
          });
          byKey['memory.search'] = out.hits;
          warnings.push(...out.warnings);
          break;
        }
        case 'git.log': {
          const out = await runGitLog({ cwd, args: args as never });
          byKey['git.log'] = out.text;
          warnings.push(...out.warnings);
          break;
        }
        case 'git.diff': {
          const out = await runGitDiff({ cwd, args: args as never });
          byKey['git.diff'] = out.text;
          warnings.push(...out.warnings);
          break;
        }
        case 'fs.glob': {
          const out = await runFsGlob({ cwd, args: args as { pattern: string } });
          byKey['fs.glob'] = out.matches;
          warnings.push(...out.warnings);
          break;
        }
        case 'dispatch_events': {
          const out = runDispatchEventsSource({ db, args: args as never });
          byKey['dispatch_events'] = out.events;
          warnings.push(...out.warnings);
          break;
        }
        case 'handoff.list_pending': {
          const out = runHandoffPendingSource({ db, args: args as never });
          byKey['handoff.list_pending'] = out.handoffs;
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
