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
import { runLatestContinuationNoteSource } from "./recall-sources/latest-continuation-note.js";
import { type MemoryHit, runMemorySearchSource } from "./recall-sources/memory.js";
import { runRegistrarStatusSource } from "./recall-sources/registrar-status.js";
import { runRoutingBiasListSource } from "./recall-sources/routing-bias-list.js";
import { runSessionEventsSource, type SessionEvent } from "./recall-sources/session-events.js";
import { runSessionFirstMovesSource } from "./recall-sources/session-first-moves.js";
import { resolveTemplateVars, type TemplateVarContext } from "./template-vars.js";

export type RecallRequiredFailure = { source: string; message: string };

export type RecallBundle = {
  byKey: Record<string, unknown>;
  warnings: string[];
  estimatedTokens: number;
  requiredFailures?: RecallRequiredFailure[];
};

export type ComposeRecallOpts = {
  db: Database;
  embedder: { embed(texts: string[]): Promise<Float32Array[]> };
  cwd: string;
  repoRoot?: string;
  storageRoot?: string;
  project: string;
  sources: RecallSource[];
  budgetTokens?: number;
  agentRegistry?: { listAgents(): { name: string }[] };
  templateCtx?: TemplateVarContext;
  now?: () => Date;
};

const DEFAULT_BUDGET = 8000;
export const TOKEN_PER_CHAR = 0.25;

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

function normalizeFileContentsArgs(args: Record<string, unknown>): {
  path: string;
  max_bytes?: number;
  allowed_roots?: string[];
} {
  const path = typeof args.path === "string" ? args.path : "";
  const maxBytes = typeof args.max_bytes === "number" ? args.max_bytes : undefined;
  const allowedRoots = Array.isArray(args.allowed_roots)
    ? args.allowed_roots.filter((root): root is string => typeof root === "string")
    : undefined;
  return {
    path: path === "~/.penumbra/pending-handoff.md" ? "penumbra-storage:pending-handoff.md" : path,
    ...(maxBytes !== undefined ? { max_bytes: maxBytes } : {}),
    ...(allowedRoots !== undefined ? { allowed_roots: allowedRoots } : {}),
  };
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
  repoRoot: string | undefined;
  storageRoot: string | undefined;
  project: string;
  agentRegistry: ComposeRecallOpts["agentRegistry"];
  now: () => Date;
};

function withUnpushed(
  result: Awaited<ReturnType<typeof runSessionFirstMovesSource>>["result"],
): Record<string, unknown> {
  return {
    ...result,
    unpushed:
      result.head_sha && result.origin_main_sha && result.head_sha === result.origin_main_sha
        ? 0
        : "differs - run git rev-list --count origin/main..main",
  };
}

async function runOneSource(
  src: RecallSource,
  args: Record<string, unknown>,
  deps: RunSourceDeps,
  byKey: Record<string, unknown>,
  warnings: string[],
): Promise<void> {
  const { db, embedder, cwd, repoRoot, storageRoot, project, agentRegistry, now } = deps;
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
      const out = await runFileContents({
        cwd,
        storageRoot,
        args: normalizeFileContentsArgs(args),
      });
      mergeBucket(byKey, "file.contents", out.result);
      warnings.push(...out.warnings);
      return;
    }
    case "latest_continuation_note": {
      const out = await runLatestContinuationNoteSource({ cwd, repoRoot, storageRoot, args });
      mergeBucket(
        byKey,
        "latest_continuation_note",
        out.result ?? { path: null, body: "no continuation note found", truncated: false },
      );
      warnings.push(...out.warnings);
      return;
    }
    case "session_first_moves": {
      const out = await runSessionFirstMovesSource({ db, cwd, project, args });
      mergeBucket(byKey, "session_first_moves", withUnpushed(out.result));
      warnings.push(...out.warnings);
      return;
    }
    case "routing_bias_list": {
      const out = runRoutingBiasListSource({ db, args, now });
      mergeBucket(byKey, "routing_bias_list", out.rows);
      warnings.push(...out.warnings);
      return;
    }
    case "registrar_status": {
      const out = runRegistrarStatusSource({ db, args });
      mergeBucket(byKey, "registrar_status", out.rows);
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

function tokenSize(value: unknown): number {
  try {
    return estTokens(JSON.stringify(value));
  } catch {
    return estTokens(String(value));
  }
}

function buildTruncationMarker(retainedChars: number, originalChars: number): string {
  return `\n… [recall budget: body truncated to ${String(retainedChars)} of ${String(originalChars)} chars]`;
}

function headAtLineBoundary(body: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const prefix = body.slice(0, maxChars);
  const lastNewline = prefix.lastIndexOf("\n");
  if (lastNewline > 0) return prefix.slice(0, lastNewline);
  return prefix;
}

function truncateObjectRecall(
  value: Record<string, unknown>,
  budgetTokens: number,
): Record<string, unknown> | null {
  if (typeof value.body !== "string") return null;
  const originalBody = value.body;
  const markerOnly = {
    ...value,
    body: buildTruncationMarker(0, originalBody.length),
    truncated: true,
  };
  if (budgetTokens <= 0) return markerOnly;

  let lo = 0;
  let hi = originalBody.length;
  let best = markerOnly;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const head = headAtLineBoundary(originalBody, mid);
    const candidate = {
      ...value,
      body: `${head}${buildTruncationMarker(head.length, originalBody.length)}`,
      truncated: true,
    };
    if (tokenSize(candidate) <= budgetTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function computeSizes(byKey: Record<string, unknown>): { total: number; sized: SizedItem[] } {
  let total = 0;
  const sized: SizedItem[] = [];
  for (const [key, val] of Object.entries(byKey)) {
    if (Array.isArray(val)) {
      for (const element of val as unknown[]) {
        const item = element as { ts?: string; created_at?: string };
        const tokens = tokenSize(item);
        sized.push({ key, ts: item.ts ?? item.created_at ?? "", tokens, ref: item });
        total += tokens;
      }
    } else if (typeof val === "string") {
      const tokens = estTokens(val);
      sized.push({ key, ts: "", tokens, ref: val });
      total += tokens;
    } else if (typeof val === "object" && val !== null) {
      const item = val as { ts?: string; created_at?: string };
      const tokens = tokenSize(item);
      sized.push({ key, ts: item.ts ?? item.created_at ?? "", tokens, ref: item });
      total += tokens;
    }
  }
  return { total, sized };
}

function protectedTrimRank(key: string): number {
  if (key === "session_first_moves") return 1;
  if (key === "latest_continuation_note") return 2;
  return 0;
}

function compareSizedItems(a: SizedItem, b: SizedItem): number {
  const aProtectedRank = protectedTrimRank(a.key);
  const bProtectedRank = protectedTrimRank(b.key);
  if (aProtectedRank !== bProtectedRank) {
    if (aProtectedRank === 0) return -1;
    if (bProtectedRank === 0) return 1;
    return aProtectedRank - bProtectedRank;
  }
  const aHasTs = a.ts.length > 0;
  const bHasTs = b.ts.length > 0;
  if (aHasTs !== bHasTs) return aHasTs ? -1 : 1;
  if (!aHasTs && !bHasTs) return b.tokens - a.tokens;
  return a.ts.localeCompare(b.ts);
}

function maybeTruncateSizedItem(
  s: SizedItem,
  cur: number,
  budget: number,
): Record<string, unknown> | null {
  if (typeof s.ref !== "object" || s.ref === null) return null;
  const remainingTokens = Math.max(0, budget - (cur - s.tokens));
  const replacement = truncateObjectRecall(s.ref as Record<string, unknown>, remainingTokens);
  if (replacement === null) return null;
  if (tokenSize(replacement) >= s.tokens) return null;
  return replacement;
}

function protectedKeepIntactOverage(s: SizedItem, cur: number, budget: number): number {
  const availableForItem = Math.max(0, budget - (cur - s.tokens));
  return Math.max(0, s.tokens - availableForItem);
}

function applyArrayTrim(
  val: unknown[],
  toDrop: Set<unknown>,
  replacements: Map<unknown, unknown>,
): unknown[] {
  return val
    .filter((v) => !toDrop.has(v))
    .map((v) => (replacements.has(v) ? replacements.get(v) : v));
}

function applyScalarTrim(
  val: unknown,
  toDrop: Set<unknown>,
  replacements: Map<unknown, unknown>,
): { changed: boolean; value: unknown } {
  if (typeof val === "string" && toDrop.has(val)) return { changed: true, value: "" };
  if (typeof val !== "object" || val === null) return { changed: false, value: val };
  if (replacements.has(val)) return { changed: true, value: replacements.get(val) };
  if (toDrop.has(val)) return { changed: true, value: null };
  return { changed: false, value: val };
}

function trimToBudget(
  byKey: Record<string, unknown>,
  sized: SizedItem[],
  total: number,
  budget: number,
  warnings: string[],
): number {
  sized.sort(compareSizedItems);
  const toDrop = new Set<unknown>();
  const replacements = new Map<unknown, unknown>();
  let cur = total;
  for (const s of sized) {
    if (cur <= budget) break;
    const replacement = maybeTruncateSizedItem(s, cur, budget);
    if (replacement !== null) {
      replacements.set(s.ref, replacement);
      cur = cur - s.tokens + tokenSize(replacement);
      continue;
    }
    if (protectedTrimRank(s.key) > 0) {
      warnings.push(
        `recall budget: protected ${s.key} kept intact (${String(
          protectedKeepIntactOverage(s, cur, budget),
        )} tokens over)`,
      );
      continue;
    }
    toDrop.add(s.ref);
    cur -= s.tokens;
  }
  for (const [key, val] of Object.entries(byKey)) {
    if (Array.isArray(val)) {
      byKey[key] = applyArrayTrim(val, toDrop, replacements);
      continue;
    }
    const next = applyScalarTrim(val, toDrop, replacements);
    if (next.changed) byKey[key] = next.value;
  }
  warnings.push(
    `recall budget exceeded: trimmed ${String(
      toDrop.size + replacements.size,
    )} items (target ${String(budget)} tokens)`,
  );
  return cur;
}

// Recall sources catch their own errors and degrade to an empty value plus a
// warning (runGitLog returns { text: "" } outside a repo; runMemorySearchSource
// returns []; the unimplemented sources at runOneSource's fallthrough set null).
// A required source therefore fails on the VALUE, not only on a thrown error.
export function isEmptyRecallValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("error" in record && typeof record.error === "string") return true;
    if ("body" in record && (record.body === null || record.body === undefined)) return true;
    return Object.keys(record).length === 0;
  }
  return false;
}

// mergeBucket writes dispatch_events under "dispatch_summaries" when the source
// returns summaries (recall.ts case "dispatch_events"); check both keys so a
// healthy summarized fetch is never mistaken for an empty one.
const RECALL_BUCKET_ALIASES: Record<string, string[]> = {
  dispatch_events: ["dispatch_events", "dispatch_summaries"],
};

export function resolveRecallSourceValue(
  byKey: Record<string, unknown>,
  source: string,
): unknown {
  for (const key of RECALL_BUCKET_ALIASES[source] ?? [source]) {
    const value = byKey[key];
    if (!isEmptyRecallValue(value)) return value;
  }
  return null;
}

async function runSourceWithRequiredCheck(
  src: RecallSource,
  args: Record<string, unknown>,
  deps: RunSourceDeps,
  byKey: Record<string, unknown>,
  warnings: string[],
): Promise<RecallRequiredFailure | null> {
  try {
    await runOneSource(src, args, deps, byKey, warnings);
    if (src.required !== true) return null;
    if (isEmptyRecallValue(resolveRecallSourceValue(byKey, src.source))) {
      return { source: src.source, message: "source produced no usable content" };
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${src.source}: ${msg}`);
    byKey[src.source] = null;
    if (src.required === true) return { source: src.source, message: msg };
    return null;
  }
}

export async function composeRecall(opts: ComposeRecallOpts): Promise<RecallBundle> {
  const { db, embedder, cwd, repoRoot, storageRoot, project, sources } = opts;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const byKey: Record<string, unknown> = {};
  const warnings: string[] = [];
  const deps: RunSourceDeps = {
    db,
    embedder,
    cwd,
    repoRoot,
    storageRoot,
    project,
    agentRegistry: opts.agentRegistry,
    now: opts.now ?? ((): Date => new Date()),
  };

  const requiredFailures: RecallRequiredFailure[] = [];
  for (const src of sources) {
    const rawArgs = (("args" in src ? src.args : undefined) ?? {}) as Record<string, unknown>;
    const args = resolveArgs(rawArgs, opts.templateCtx);
    const failure = await runSourceWithRequiredCheck(src, args, deps, byKey, warnings);
    if (failure) requiredFailures.push(failure);
  }

  const { total, sized } = computeSizes(byKey);
  let finalTotal = total;
  if (total > budget) {
    finalTotal = trimToBudget(byKey, sized, total, budget, warnings);
  }

  return {
    byKey,
    warnings,
    estimatedTokens: finalTotal,
    ...(requiredFailures.length > 0 ? { requiredFailures } : {}),
  };
}

export type { DispatchEvent, DispatchSummary, Handoff, MemoryHit, SessionEvent };
