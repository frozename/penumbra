import type { WebResearchAdapter, WebResearchResult } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import crypto from "node:crypto";

import type { DreamConfig, DreamPhaseCostEstimatesUsd } from "./config.js";
import type {
  ContentQualityJudge,
  ContentQualityVerdict,
} from "./curator/content-quality-judge.js";
import type { DreamCostMeter, ProjectRegistryEntry } from "./cycle.js";

import { isDomainAllowed } from "../research/firecrawl-adapter.js";
import { buildJudgePromptBlock, sanitizeResearchMarkdown } from "../research/sanitization.js";

export interface ResearchDeps {
  getResearchAdapter?: (project: ProjectRegistryEntry) => WebResearchAdapter | null;
  projectRegistry?: { get(id: string): ProjectRegistryEntry | undefined };
  contentQualityJudge?: ContentQualityJudge;
  costMeter?: DreamCostMeter;
  phaseCostEstimates?: DreamPhaseCostEstimatesUsd;
}

interface ResearchActionRow {
  action_id: string;
  target_ids: string;
  payload_json: string;
}

interface ResearchPayload {
  query?: unknown;
  url?: unknown;
}

interface ResearchCacheRow {
  url: string;
  title: string;
  markdown: string;
  fetched_at: string;
  provider: WebResearchResult["source_provider"];
  is_negative: number | null;
  expires_at: number;
}

interface ParsedAction {
  project_id: string;
  query: string;
  urlFromPayload?: string;
}

interface FetchOutcome {
  results: WebResearchResult[];
  usedExternalResearchCall: boolean;
}

function sanitizeUsd(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function hashQuery(query: string, url: string): string {
  return crypto
    .createHash("sha256")
    .update(query + "|" + url)
    .digest("hex");
}

function parseAction(action: ResearchActionRow): ParsedAction {
  let project_id = "";
  try {
    const targets = JSON.parse(action.target_ids) as unknown;
    if (Array.isArray(targets) && targets.length > 0 && typeof targets[0] === "string") {
      project_id = targets[0];
    }
  } catch {
    // fall through with empty project_id
  }

  let query = "";
  let urlFromPayload: string | undefined;
  try {
    const payload = JSON.parse(action.payload_json) as ResearchPayload;
    query = typeof payload.query === "string" ? payload.query : "";
    urlFromPayload = typeof payload.url === "string" ? payload.url : undefined;
  } catch {
    // fall through with empty query
  }

  return { project_id, query, urlFromPayload };
}

function markActionFailed(db: Database, actionId: string, decidedBy?: string): void {
  if (decidedBy) {
    db.prepare(
      `UPDATE dream_actions SET status='failed', decided_by=?, decided_at=? WHERE action_id=?`,
    ).run(decidedBy, Date.now(), actionId);
  } else {
    db.prepare(`UPDATE dream_actions SET status='failed', decided_at=? WHERE action_id=?`).run(
      Date.now(),
      actionId,
    );
  }
}

function markActionCompleted(db: Database, actionId: string): void {
  db.prepare(`UPDATE dream_actions SET status='completed', decided_at=? WHERE action_id=?`).run(
    Date.now(),
    actionId,
  );
}

function readCache(db: Database, cacheKey: string): ResearchCacheRow | null {
  const row = db
    .prepare(`SELECT * FROM dream_research_cache WHERE cache_key=?`)
    .get(cacheKey) as ResearchCacheRow | null;
  return row;
}

function writeNegativeCache(
  db: Database,
  cacheKey: string,
  projectId: string,
  resolvedUrl: string,
  now: number,
  expiresAt: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO dream_research_cache(
      cache_key, provider, project_id, url, query_hash, title, markdown, fetched_at, expires_at, source_billed_usd, is_negative
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(cacheKey, "negative", projectId, resolvedUrl, cacheKey, "", "", now, expiresAt, 0);
}

function writeResultCache(
  db: Database,
  cacheKey: string,
  projectId: string,
  result: WebResearchResult,
  now: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO dream_research_cache(cache_key, provider, project_id, url, query_hash, title, markdown, fetched_at, expires_at, source_billed_usd)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cacheKey,
    result.source_provider,
    projectId,
    result.url,
    cacheKey,
    result.title,
    result.markdown,
    now,
    now + 7 * 24 * 3600 * 1000,
    result.source_billed_usd ?? 0,
  );
}

async function fetchExternalResults(
  adapter: WebResearchAdapter,
  query: string,
  resolvedUrl: string,
  allowedDomains: string[],
): Promise<WebResearchResult[]> {
  if (resolvedUrl.startsWith("http")) {
    if (allowedDomains.length > 0) {
      const hostname = new URL(resolvedUrl).hostname;
      if (!isDomainAllowed(hostname, allowedDomains)) {
        throw new Error(`domain not allowed: ${hostname}`);
      }
    }
    return [await adapter.scrape({ url: resolvedUrl })];
  }

  const searchResults = await adapter.search({
    query,
    max_pages: 1,
    allowed_domains: allowedDomains.length > 0 ? allowedDomains : null,
  });
  if (searchResults.length === 0) {
    throw new Error("no results");
  }
  return searchResults;
}

function applyDomainGate(
  results: WebResearchResult[],
  allowedDomains: string[],
): WebResearchResult[] {
  if (allowedDomains.length === 0) return results;
  return results.filter((r) => {
    try {
      return isDomainAllowed(new URL(r.url).hostname, allowedDomains);
    } catch {
      return false;
    }
  });
}

async function scoreResults(
  results: WebResearchResult[],
  query: string,
  judge: ContentQualityJudge | undefined,
): Promise<{ result: WebResearchResult; verdict: ContentQualityVerdict | null }[]> {
  if (!judge) {
    return results.map((result) => ({ result, verdict: null }));
  }
  return await Promise.all(
    results.map(async (result) => ({
      result,
      verdict: await judge.judge(result, query),
    })),
  );
}

function insertEnrichmentAction(
  db: Database,
  cycleId: string,
  projectId: string,
  result: WebResearchResult,
  verdict: ContentQualityVerdict | null,
): void {
  const targetIds = JSON.stringify([projectId]);
  const existing = db
    .prepare(
      `SELECT 1
       FROM dream_actions
       WHERE phase='P5'
         AND action_type='research_enrichment'
         AND target_ids=?
         AND json_extract(payload_json, '$.source_url')=?
         AND reverted_by IS NULL
       LIMIT 1`,
    )
    .get(targetIds, result.url);
  if (existing) return;

  const sanitized = sanitizeResearchMarkdown(result.markdown, { maxMarkdownTokens: 2000 });
  const block = buildJudgePromptBlock({
    url: result.url,
    markdown: sanitized,
    provider: result.source_provider,
  });

  const payload: {
    markdown: string;
    source_url: string;
    quality_score?: number;
    low_quality?: boolean;
  } = {
    markdown: block,
    source_url: result.url,
  };

  if (verdict !== null) {
    payload.quality_score = verdict.score;
    if (verdict.lowQuality) {
      payload.low_quality = true;
    }
  }

  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, untrusted_source)
     VALUES(?, ?, 'P5', 'research_enrichment', 0.9, 'queued', ?, ?, 1)`,
  ).run(crypto.randomUUID(), cycleId, targetIds, JSON.stringify(payload));
}

interface ActionContext {
  parsed: ParsedAction;
  adapter: WebResearchAdapter;
  resolvedUrl: string;
  cacheKey: string;
  allowedDomains: string[];
  now: number;
  negativeCacheTtlMs: number;
}

function resolveActionContext(
  config: DreamConfig,
  deps: ResearchDeps,
  parsed: ParsedAction,
): ActionContext | null {
  const project = deps.projectRegistry?.get(parsed.project_id);
  const dreamingConfig = (project?.dreaming ?? {}) as { allowed_domains?: string[] };
  const adapter = project ? (deps.getResearchAdapter?.(project) ?? null) : null;
  if (!adapter) return null;
  const resolvedUrl = parsed.urlFromPayload ?? parsed.query;
  return {
    parsed,
    adapter,
    resolvedUrl,
    cacheKey: hashQuery(parsed.query, resolvedUrl),
    allowedDomains: dreamingConfig.allowed_domains ?? [],
    now: Date.now(),
    negativeCacheTtlMs: config.negativeCacheTtlMs ?? 3_600_000,
  };
}

function readCachedOutcome(
  db: Database,
  ctx: ActionContext,
): { kind: "negative" } | { kind: "positive"; outcome: FetchOutcome } | { kind: "miss" } {
  const cached = readCache(db, ctx.cacheKey);
  if (cached === null) return { kind: "miss" };
  if (Number(cached.is_negative) === 1) {
    return cached.expires_at > ctx.now ? { kind: "negative" } : { kind: "miss" };
  }
  return {
    kind: "positive",
    outcome: {
      results: [
        {
          url: cached.url,
          title: cached.title,
          markdown: cached.markdown,
          fetched_at: cached.fetched_at,
          source_provider: cached.provider,
        },
      ],
      usedExternalResearchCall: false,
    },
  };
}

async function fetchAndCache(db: Database, ctx: ActionContext): Promise<FetchOutcome | null> {
  try {
    const fetched = await fetchExternalResults(
      ctx.adapter,
      ctx.parsed.query,
      ctx.resolvedUrl,
      ctx.allowedDomains,
    );
    for (const [i, result] of fetched.entries()) {
      // The first result is cached under the lookup-shaped key (hashQuery(query, resolvedUrl)).
      // For search actions resolvedUrl === query, so the per-URL key chosen below would never
      // match a future lookup and the cache would be write-only — re-billing every cycle.
      const resultCacheKey = i === 0 ? ctx.cacheKey : hashQuery(ctx.parsed.query, result.url);
      writeResultCache(db, resultCacheKey, ctx.parsed.project_id, result, ctx.now);
    }
    return { results: fetched, usedExternalResearchCall: true };
  } catch {
    return null;
  }
}

function recordResearchCost(deps: ResearchDeps, outcome: FetchOutcome, estimateUsd: number): void {
  if (!outcome.usedExternalResearchCall || !deps.costMeter) return;
  const billedUsd = outcome.results.reduce(
    (sum, result) => sum + sanitizeUsd(result.source_billed_usd ?? 0),
    0,
  );
  deps.costMeter.record("P5", "research", billedUsd > 0 ? billedUsd : estimateUsd);
}

async function processAction(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  deps: ResearchDeps,
  action: ResearchActionRow,
): Promise<void> {
  const researchEstimateUsd = sanitizeUsd(deps.phaseCostEstimates?.p5ResearchUsd ?? 0);
  if (
    researchEstimateUsd > 0 &&
    deps.costMeter &&
    !deps.costMeter.canAfford("P5", "research", researchEstimateUsd)
  ) {
    return;
  }

  const parsed = parseAction(action);
  if (!parsed.project_id || !parsed.query) {
    markActionFailed(db, action.action_id);
    return;
  }

  const ctx = resolveActionContext(config, deps, parsed);
  if (!ctx) {
    markActionFailed(db, action.action_id);
    return;
  }

  const cachedOutcome = readCachedOutcome(db, ctx);
  if (cachedOutcome.kind === "negative") {
    markActionFailed(db, action.action_id, "negative-cache-hit");
    return;
  }

  let outcome: FetchOutcome;
  if (cachedOutcome.kind === "positive") {
    outcome = cachedOutcome.outcome;
  } else {
    const fetched = await fetchAndCache(db, ctx);
    if (!fetched) {
      writeNegativeCache(
        db,
        ctx.cacheKey,
        ctx.parsed.project_id,
        ctx.resolvedUrl,
        ctx.now,
        ctx.now + ctx.negativeCacheTtlMs,
      );
      markActionFailed(db, action.action_id);
      return;
    }
    outcome = fetched;
  }

  recordResearchCost(deps, outcome, researchEstimateUsd);

  const domainGated = applyDomainGate(outcome.results, ctx.allowedDomains);
  const scored = await scoreResults(domainGated, ctx.parsed.query, deps.contentQualityJudge);

  if (scored.length === 0) {
    writeNegativeCache(
      db,
      ctx.cacheKey,
      ctx.parsed.project_id,
      ctx.resolvedUrl,
      ctx.now,
      ctx.now + ctx.negativeCacheTtlMs,
    );
    markActionFailed(db, action.action_id);
    return;
  }

  for (const { result, verdict } of scored) {
    insertEnrichmentAction(db, cycleId, ctx.parsed.project_id, result, verdict);
  }

  markActionCompleted(db, action.action_id);
}

export async function runP5Phase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  deps: ResearchDeps,
): Promise<void> {
  const K = 10; // Top K from P4 queue

  const pendingResearch = db
    .prepare(
      `SELECT action_id, target_ids, payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query' AND status='queued' LIMIT ?`,
    )
    .all(K) as ResearchActionRow[];

  for (const action of pendingResearch) {
    await processAction(db, cycleId, config, deps, action);
  }
}
