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

function stubFirecrawlMulti(): FirecrawlTransport {
  return {
    async search(): Promise<FirecrawlSearchResponse> {
      return {
        data: [
          { url: 'https://allowed.com/result', title: 'Allowed' },
          { url: 'https://evil.com/result', title: 'Evil' },
          { url: 'https://sub.allowed.com/result', title: 'Sub Allowed' },
        ],
      };
    },
    async scrape(): Promise<FirecrawlScrapeResponse> {
      return { data: {} };
    },
  };
}

it('search with allowed_domains rejects results from disallowed host', async () => {
  const adapter = new FirecrawlAdapter({}, stubFirecrawlMulti());
  const results = await adapter.search({
    query: 'test',
    allowed_domains: ['allowed.com'],
  });
  expect(results.length).toBe(2);
  expect(results[0].url).toBe('https://allowed.com/result');
  expect(results[1].url).toBe('https://sub.allowed.com/result');
});

it('search with no allowed_domains returns all results', async () => {
  const adapter = new FirecrawlAdapter({}, stubFirecrawlMulti());
  const results = await adapter.search({ query: 'test' });
  expect(results.length).toBe(3);
});

it('FirecrawlWithFallbackAdapter forwards allowed_domains to fallback after 401', async () => {
  const adapter = createResearchAdapter({ provider: 'firecrawl' }, stubFirecrawl401());
  
  // DDG not in allowed_domains -> WebFetchAdapter should return empty
  const results1 = await adapter.search({
    query: 'test',
    allowed_domains: ['allowed.com'],
  });
  expect(results1.length).toBe(0);

  // DDG in allowed_domains -> WebFetchAdapter should return DDG URL
  const results2 = await adapter.search({
    query: 'test',
    allowed_domains: ['duckduckgo.com'],
  });
  expect(results2.length).toBe(1);
  expect(results2[0].url).toContain('duckduckgo.com');
  expect(results2[0].source_provider).toBe('webfetch');
});

function stubCapturing() {
  let lastSearchArgs: Parameters<FirecrawlTransport['search']>[0] | undefined;
  const transport: FirecrawlTransport = {
    search: async (args) => {
      lastSearchArgs = args;
      return { data: [], source_billed_usd: undefined };
    },
    scrape: async () => {
      throw new Error('stub: scrape not implemented');
    },
  };
  return { transport, getLastArgs: () => lastSearchArgs };
}

it('search with allowed_domains sends includeDomains and keeps query bare', async () => {
  const { transport, getLastArgs } = stubCapturing();
  const adapter = new FirecrawlAdapter({}, transport);
  await adapter.search({ query: 'allSettled', allowed_domains: ['react.dev', 'mdn.io'] });
  const args = getLastArgs();
  expect(args?.query).toBe('allSettled');
  expect(args?.includeDomains).toEqual(['react.dev', 'mdn.io']);
  expect(args?.ignoreInvalidURLs).toBe(true);
});

it('search without allowed_domains passes bare query to transport', async () => {
  const { transport, getLastArgs } = stubCapturing();
  const adapter = new FirecrawlAdapter({}, transport);
  await adapter.search({ query: 'allSettled' });
  const args = getLastArgs();
  expect(args?.query).toBe('allSettled');
  expect(args?.includeDomains).toBeUndefined();
  expect(args?.ignoreInvalidURLs).toBe(true);
});
