import crypto from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { DreamConfig } from './config.js';
import type { WebResearchAdapter, WebResearchResult } from '@penumbra/core';
import type { ContentQualityJudge } from './curator/content-quality-judge.js';
import { sanitizeResearchMarkdown, buildJudgePromptBlock } from '../research/sanitization.js';

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
    try {
      const payload = JSON.parse(action.payload_json);
      query = payload.query || '';
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

    let urlToFetch = ''; // assuming query contains url or we do a search
    try {
      const payload = JSON.parse(action.payload_json);
      urlToFetch = payload.url || query; // simplified for now
    } catch {}

    const cacheKey = hashQuery(query, urlToFetch);
    const cached = db.prepare(`SELECT * FROM dream_research_cache WHERE cache_key=?`).get(cacheKey) as any;
    const useAllowedDomains = !deps.contentQualityJudge;
    const allowedDomains = dreamingConfig.allowed_domains || [];
    const now = Date.now();
    let results: WebResearchResult[] = [];

    if (cached) {
      results = [{
        url: cached.url,
        title: cached.title,
        markdown: cached.markdown,
        fetched_at: cached.fetched_at,
        source_provider: cached.provider,
      }];
    } else {
      try {
        if (urlToFetch.startsWith('http')) {
          if (useAllowedDomains && allowedDomains.length > 0) {
            const domain = new URL(urlToFetch).hostname;
            if (!allowedDomains.includes(domain)) {
              throw new Error('domain not allowed');
            }
          }
          results = [await researchAdapter.scrape({ url: urlToFetch })];
        } else {
          const searchResults = await researchAdapter.search({
            query,
            max_pages: 1,
            allowed_domains: useAllowedDomains && allowedDomains.length > 0 ? allowedDomains : null,
          });
          if (!searchResults || searchResults.length === 0) throw new Error('no results');
          results = searchResults;
        }

        for (const fetchResult of results) {
          const resultCacheKey = hashQuery(query, fetchResult.url);
          db.prepare(
            `INSERT OR IGNORE INTO dream_research_cache(cache_key, provider, project_id, url, query_hash, title, markdown, fetched_at, expires_at, source_billed_usd)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            resultCacheKey,
            fetchResult.source_provider,
            project_id,
            fetchResult.url,
            cacheKey,
            fetchResult.title,
            fetchResult.markdown,
            now,
            now + 7 * 24 * 3600 * 1000,
            fetchResult.source_billed_usd || 0
          );
        }

      } catch (err) {
        db.prepare(`UPDATE dream_actions SET status='failed', decided_at=? WHERE action_id=?`).run(Date.now(), action.action_id);
        continue;
      }
    }

    for (const result of results) {
      const sanitized = sanitizeResearchMarkdown(result.markdown, { maxMarkdownTokens: 2000 });
      const block = buildJudgePromptBlock({
        url: result.url,
        markdown: sanitized,
        provider: result.source_provider || provider,
      });

      const payload: { markdown: string; quality_score?: number; low_quality?: boolean } = { markdown: block };

      if (deps.contentQualityJudge) {
        const verdict = await deps.contentQualityJudge.judge(
          { url: result.url, title: result.title, markdown: result.markdown },
          query,
        );
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
