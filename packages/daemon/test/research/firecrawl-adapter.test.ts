import { expect, it } from 'bun:test';
import {
  FirecrawlAdapter,
  createResearchAdapter,
  type FirecrawlTransport,
  type FirecrawlSearchResponse,
  type FirecrawlScrapeResponse,
} from '../../src/research/firecrawl-adapter.js';

function stubFirecrawl401(): FirecrawlTransport {
  return {
    async search(): Promise<FirecrawlSearchResponse> {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    },
    async scrape(): Promise<FirecrawlScrapeResponse> {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    },
  };
}

function stubFirecrawlWithBilling(opts: { billed_usd: number }): FirecrawlTransport {
  return {
    async search(): Promise<FirecrawlSearchResponse> {
      return {
        data: [
          {
            url: 'https://example.com/result',
            title: 'Test result',
            markdown: 'Test markdown content',
            source_billed_usd: opts.billed_usd,
          },
        ],
        source_billed_usd: opts.billed_usd,
      };
    },
    async scrape(): Promise<FirecrawlScrapeResponse> {
      return {
        data: { url: 'https://example.com', title: 'Test page', markdown: 'Test markdown' },
        source_billed_usd: opts.billed_usd,
      };
    },
  };
}

it('domain re-verification rejects URL resolving to disallowed domain after redirect', async () => {
  const adapter = new FirecrawlAdapter({ allowedDomains: ['trusted.com'] });
  await expect(adapter.scrape({ url: 'https://evil.com/redirect' })).rejects.toMatch(/domain/i);
});

it('firecrawl 401 falls back to webfetch adapter', async () => {
  const adapter = createResearchAdapter({ provider: 'firecrawl' }, stubFirecrawl401());
  const result = await adapter.search({ query: 'test query' });
  expect(result[0].source_provider).toBe('webfetch');
});

it('source_billed_usd captured from firecrawl provider response', async () => {
  const adapter = new FirecrawlAdapter({}, stubFirecrawlWithBilling({ billed_usd: 0.003 }));
  const results = await adapter.search({ query: 'test' });
  expect(results[0].source_billed_usd).toBe(0.003);
});
