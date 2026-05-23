import crypto from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { DreamConfig } from './config.js';
import type { WebResearchAdapter, WebResearchResult } from '@penumbra/core';
import type { ContentQualityJudge } from './curator/content-quality-judge.js';
import { sanitizeResearchMarkdown, buildJudgePromptBlock } from '../research/sanitization.js';
import { isDomainAllowed } from '../research/firecrawl-adapter.js';

export interface ResearchDeps {
  getResearchAdapter?: (project: any) => WebResearchAdapter | null;
  projectRegistry?: { get(id: string): any };
  contentQualityJudge?: ContentQualityJudge;
}

function hashQuery(query: string, url: string): string {
  return crypto.createHash('sha256').update(query + '|' + url).digest('hex');
}

export async function runP5Phase(
  db: Database,
  cycleId: string,
  config: DreamConfig,
  deps: ResearchDeps
): Promise<void> {
  const K = 10; // Top K from P4 queue

  const pendingResearch = db.prepare(
    `SELECT action_id, target_ids, payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query' AND status='queued' LIMIT ?`
  ).all(K) as Array<{ action_id: string; target_ids: string; payload_json: string }>;

  for (const action of pendingResearch) {
    let project_id = '';
    try {
      const targets = JSON.parse(action.target_ids);
      if (targets && targets.length > 0) project_id = targets[0];
    } catch {}

    let query = '';
    let urlFromPayload: string | undefined;
    try {
      const payload = JSON.parse(action.payload_json);
      query = payload.query || '';
      urlFromPayload = payload.url ?? undefined;
    } catch {}

    if (!project_id || !query) {
      db.prepare(`UPDATE dream_actions SET status='failed', decided_at=? WHERE action_id=?`).run(Date.now(), action.action_id);
      continue;
    }

    const project = deps.projectRegistry?.get(project_id);
    const dreamingConfig = project?.dreaming || { research_provider: 'off' };
    const provider = (dreamingConfig.research_provider || 'off') as string;
    const researchAdapter = project ? (deps.getResearchAdapter?.(project) ?? null) : null;

    if (!researchAdapter) {
      db.prepare(`UPDATE dream_actions SET status='failed', decided_at=? WHERE action_id=?`).run(Date.now(), action.action_id);
      continue;
    }

    const resolvedUrl = urlFromPayload ?? query;
    const cacheKey = hashQuery(query, resolvedUrl);
    const allowedDomains: string[] = dreamingConfig.allowed_domains || [];
    const now = Date.now();
    const negativeCacheTtlMs = config.negativeCacheTtlMs ?? 3_600_000;
    let rawResults: WebResearchResult[] = [];

    const cacheNegativeResult = () => {
      db.prepare(
        `INSERT OR REPLACE INTO dream_research_cache(
          cache_key, provider, project_id, url, query_hash, title, markdown, fetched_at, expires_at, source_billed_usd, is_negative
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        cacheKey,
        'negative',
        project_id,
        resolvedUrl,
        cacheKey,
        '',
        '',
        now,
        now + negativeCacheTtlMs,
        0
      );
    };

    const cached = db.prepare(`SELECT * FROM dream_research_cache WHERE cache_key=?`).get(cacheKey) as any;

    if (cached) {
      if (Number(cached.is_negative) === 1 && cached.expires_at > now) {
        db.prepare(`UPDATE dream_actions SET status='failed', decided_by='negative-cache-hit', decided_at=? WHERE action_id=?`).run(
          Date.now(),
          action.action_id,
        );
        continue;
      }

      rawResults = [{
        url: cached.url,
        title: cached.title,
        markdown: cached.markdown,
        fetched_at: cached.fetched_at,
        source_provider: cached.provider,
      }];
    } else {
      try {
        if (resolvedUrl.startsWith('http')) {
          // Pre-scrape domain check — always apply regardless of judge presence
          if (allowedDomains.length > 0) {
            const hostname = new URL(resolvedUrl).hostname;
            if (!isDomainAllowed(hostname, allowedDomains)) {
              throw new Error(`domain not allowed: ${hostname}`);
            }
          }
          rawResults = [await researchAdapter.scrape({ url: resolvedUrl })];
        } else {
          const searchResults = await researchAdapter.search({
            query,
            max_pages: 1,
            allowed_domains: allowedDomains.length > 0 ? allowedDomains : null,
          });
          if (!searchResults || searchResults.length === 0) {
            cacheNegativeResult();
            throw new Error('no results');
          }
          rawResults = searchResults;
        }

        for (let i = 0; i < rawResults.length; i++) {
          const fetchResult = rawResults[i];
          if (!fetchResult) continue;
          // The first result is cached under the lookup-shaped key (hashQuery(query, resolvedUrl)).
          // For search actions resolvedUrl === query, so the per-URL key chosen below would never
          // match a future lookup and the cache would be write-only — re-billing every cycle.
          const resultCacheKey = i === 0 ? cacheKey : hashQuery(query, fetchResult.url);
          db.prepare(
            `INSERT OR IGNORE INTO dream_research_cache(cache_key, provider, project_id, url, query_hash, title, markdown, fetched_at, expires_at, source_billed_usd)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            resultCacheKey,
            fetchResult.source_provider,
            project_id,
            fetchResult.url,
            resultCacheKey,
            fetchResult.title,
            fetchResult.markdown,
            now,
            now + 7 * 24 * 3600 * 1000,
            fetchResult.source_billed_usd || 0
          );
        }
      } catch (err) {
        cacheNegativeResult();
        db.prepare(`UPDATE dream_actions SET status='failed', decided_at=? WHERE action_id=?`).run(Date.now(), action.action_id);
        continue;
      }
    }

    // F1: domain gate ALWAYS runs post-fetch; judge only scores domain-allowed survivors
    const domainGated = allowedDomains.length > 0
      ? rawResults.filter(r => {
          try { return isDomainAllowed(new URL(r.url).hostname, allowedDomains); }
          catch { return false; }
        })
      : rawResults;

    const scored = deps.contentQualityJudge
      ? await Promise.all(domainGated.map(async r => ({ r, verdict: await deps.contentQualityJudge!.judge(r, query) })))
      : domainGated.map(r => ({ r, verdict: null as any }));

    if (scored.length === 0) {
      cacheNegativeResult();
      db.prepare(`UPDATE dream_actions SET status='failed', decided_at=? WHERE action_id=?`).run(Date.now(), action.action_id);
      continue;
    }

    for (const { r: result, verdict } of scored) {
      const sanitized = sanitizeResearchMarkdown(result.markdown, { maxMarkdownTokens: 2000 });
      const block = buildJudgePromptBlock({
        url: result.url,
        markdown: sanitized,
        provider: result.source_provider || provider,
      });

      const payload: { markdown: string; quality_score?: number; low_quality?: boolean } = { markdown: block };

      if (verdict !== null) {
        payload.quality_score = verdict.score;
        if (verdict.lowQuality) {
          payload.low_quality = true;
        }
      }

      db.prepare(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, untrusted_source)
         VALUES(?, ?, 'P5', 'research_enrichment', 0.9, 'queued', ?, ?, 1)`
      ).run(
        crypto.randomUUID(),
        cycleId,
        JSON.stringify([project_id]),
        JSON.stringify(payload)
      );
    }

    db.prepare(`UPDATE dream_actions SET status='completed', decided_at=? WHERE action_id=?`).run(Date.now(), action.action_id);
  }
}
