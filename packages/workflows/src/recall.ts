import type { Database } from "bun:sqlite";

import type { RecallSource } from "./schema.js";

import { runAgentsSource } from "./recall-sources/agents.js";
import {
  type DispatchEvent,
  type DispatchSummary,
  runDispatchEventsSource,
} from "./recall-sources/dispatch.js";
import { runFileContents } from "./recall-sources/file-contents.js";
import { runFsGlob } from "./recall-sources/fs.js";
import { runGitDiff, runGitLog, runGitShow } from "./recall-sources/git.js";
import { type Handoff, runHandoffPendingSource } from "./recall-sources/handoff.js";
import { type MemoryHit, runMemorySearchSource } from "./recall-sources/memory.js";
import { runSessionEventsSource, type SessionEvent } from "./recall-sources/session-events.js";
import { resolveTemplateVars, type TemplateVarContext } from "./template-vars.js";

export type RecallBundle = {
  byKey: Record<string, unknown>;
  warnings: string[];
  estimatedTokens: number;
};

export type ComposeRecallOpts = {
  db: Database;
  embedder: { embed(texts: string[]): Promise<Float32Array[]> };
  cwd: string;
  storageRoot?: string;
  project: string;
  sources: RecallSource[];
  budgetTokens?: number;
  agentRegistry?: { listAgents(): { name: string }[] };
  templateCtx?: TemplateVarContext;
};

const DEFAULT_BUDGET = 8000;
const TOKEN_PER_CHAR = 0.25;

function estTokens(s: string): number {
  return Math.ceil(s.length * TOKEN_PER_CHAR);
}

function resolveArgs(
  args: Record<string, unknown>,
  ctx: TemplateVarContext | undefined,
): Record<string, unknown> {
  if (!ctx) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? resolveTemplateVars(v, ctx) : v;
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
    const merged: unknown[] = [];
    for (const e of existing as unknown[]) merged.push(e);
    for (const v of value as unknown[]) merged.push(v);
    bucket[key] = merged;
    return;
  }
  if (typeof existing === "string" && typeof value === "string") {
    bucket[key] = existing.length === 0 ? value : `${existing}\n${value}`;
    return;
  }
  bucket[key] = value;
}

type RunSourceDeps = {
  db: Database;
  embedder: ComposeRecallOpts["embedder"];
  cwd: string;
  storageRoot: string | undefined;
  project: string;
  agentRegistry: ComposeRecallOpts["agentRegistry"];
};

async function runOneSource(
  src: RecallSource,
  args: Record<string, unknown>,
  deps: RunSourceDeps,
  byKey: Record<string, unknown>,
  warnings: string[],
): Promise<void> {
  const { db, embedder, cwd, storageRoot, project, agentRegistry } = deps;
  switch (src.source) {
    case "memory_search": {
      const out = await runMemorySearchSource({ db, embedder, args: { project, ...args } });
      mergeBucket(byKey, "memory_search", out.hits);
      warnings.push(...out.warnings);
      return;
    }
    case "git.log": {
      const out = await runGitLog({ cwd, args });
      mergeBucket(byKey, "git.log", out.text);
      warnings.push(...out.warnings);
      return;
    }
    case "git.diff": {
      const out = await runGitDiff({ cwd, args });
      mergeBucket(byKey, "git.diff", out.text);
      warnings.push(...out.warnings);
      return;
    }
    case "git.show": {
      const out = await runGitShow({ cwd, args });
      mergeBucket(byKey, "git.show", out.commits);
      warnings.push(...out.warnings);
      return;
    }
    case "file.contents": {
      const out = await runFileContents({ cwd, storageRoot, args: args as never });
      mergeBucket(byKey, "file.contents", out.result);
      warnings.push(...out.warnings);
      return;
    }
    case "fs_glob": {
      const out = await runFsGlob({ cwd, args: args as { pattern: string } });
      mergeBucket(byKey, "fs_glob", out.matches);
      warnings.push(...out.warnings);
      return;
    }
    case "dispatch_events": {
      const out = runDispatchEventsSource({ db, args });
      if (out.summaries) {
        mergeBucket(byKey, "dispatch_summaries", out.summaries);
      } else {
        mergeBucket(byKey, "dispatch_events", out.events);
      }
      warnings.push(...out.warnings);
      return;
    }
    case "session_events": {
      const out = runSessionEventsSource({ db, args });
      mergeBucket(byKey, "session_events", out.events);
      warnings.push(...out.warnings);
      return;
    }
    case "handoff_list_pending": {
      const out = runHandoffPendingSource({ db, args });
      mergeBucket(byKey, "handoff_list_pending", out.handoffs);
      warnings.push(...out.warnings);
      return;
    }
    case "agents": {
      const out = runAgentsSource({ agentRegistry });
      mergeBucket(byKey, "agents", out.agents);
      warnings.push(...out.warnings);
      return;
    }
    case "memory_timeline":
    case "memory_get_observations":
    case "fs_grep":
    case "daemon.endpoint":
      warnings.push(`unsupported source kind in MVP: ${src.source}`);
      byKey[src.source] = null;
  }
}

type SizedItem = { key: string; ts: string; tokens: number; ref: unknown };

function computeSizes(byKey: Record<string, unknown>): { total: number; sized: SizedItem[] } {
  let total = 0;
  const sized: SizedItem[] = [];
  for (const [key, val] of Object.entries(byKey)) {
    if (Array.isArray(val)) {
      for (const element of val as unknown[]) {
        const item = element as { ts?: string; created_at?: string };
        const tokens = estTokens(JSON.stringify(item));
        sized.push({ key, ts: item.ts ?? item.created_at ?? "", tokens, ref: item });
        total += tokens;
      }
    } else if (typeof val === "string") {
      const tokens = estTokens(val);
      sized.push({ key, ts: "", tokens, ref: val });
      total += tokens;
    }
  }
  return { total, sized };
}

function trimToBudget(
  byKey: Record<string, unknown>,
  sized: SizedItem[],
  total: number,
  budget: number,
  warnings: string[],
): number {
  sized.sort((a, b) => {
    const aHasTs = a.ts.length > 0;
    const bHasTs = b.ts.length > 0;
    if (aHasTs !== bHasTs) return aHasTs ? -1 : 1;
    if (!aHasTs && !bHasTs) return 0;
    return a.ts.localeCompare(b.ts);
  });
  const toDrop = new Set<unknown>();
  let cur = total;
  for (const s of sized) {
    if (cur <= budget) break;
    toDrop.add(s.ref);
    cur -= s.tokens;
  }
  for (const [key, val] of Object.entries(byKey)) {
    if (Array.isArray(val)) {
      byKey[key] = (val as unknown[]).filter((v) => !toDrop.has(v));
    } else if (typeof val === "string" && toDrop.has(val)) {
      byKey[key] = "";
    }
  }
  warnings.push(
    `recall budget exceeded: trimmed ${String(toDrop.size)} items (target ${String(budget)} tokens)`,
  );
  return cur;
}

export async function composeRecall(opts: ComposeRecallOpts): Promise<RecallBundle> {
  const { db, embedder, cwd, storageRoot, project, sources } = opts;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const byKey: Record<string, unknown> = {};
  const warnings: string[] = [];
  const deps: RunSourceDeps = {
    db,
    embedder,
    cwd,
    storageRoot,
    project,
    agentRegistry: opts.agentRegistry,
  };

  for (const src of sources) {
    const rawArgs = (("args" in src ? src.args : undefined) ?? {}) as Record<string, unknown>;
    const args = resolveArgs(rawArgs, opts.templateCtx);
    try {
      await runOneSource(src, args, deps, byKey, warnings);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`${src.source}: ${msg}`);
      byKey[src.source] = null;
    }
  }

  const { total, sized } = computeSizes(byKey);
  let finalTotal = total;
  if (total > budget) {
    finalTotal = trimToBudget(byKey, sized, total, budget, warnings);
  }

  return { byKey, warnings, estimatedTokens: finalTotal };
}

export type { DispatchEvent, DispatchSummary, Handoff, MemoryHit, SessionEvent };
