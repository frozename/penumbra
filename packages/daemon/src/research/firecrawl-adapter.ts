import type { WebResearchAdapter, WebResearchResult } from '../../../core/src/research/types.js';
import { OffAdapter } from './off-adapter.js';
import { WebFetchAdapter } from './webfetch-adapter.js';

// Injectable transport — real impl hits the Firecrawl HTTP API; test stubs override.
export interface FirecrawlTransport {
  search(args: { query: string; max_pages?: number }): Promise<FirecrawlSearchResponse>;
  scrape(args: { url: string }): Promise<FirecrawlScrapeResponse>;
}

export interface FirecrawlSearchResponse {
  data: Array<{
    url: string;
    title?: string;
    markdown?: string;
    source_billed_usd?: number;
  }>;
  source_billed_usd?: number;
}

export interface FirecrawlScrapeResponse {
  data: {
    url?: string;
    title?: string;
    markdown?: string;
    source_billed_usd?: number;
  };
  source_billed_usd?: number;
}

class DefaultFirecrawlTransport implements FirecrawlTransport {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.FIRECRAWL_API_KEY ?? '';
    this.baseUrl = process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev';
  }

  async search(args: { query: string; max_pages?: number }): Promise<FirecrawlSearchResponse> {
    const res = await fetch(`${this.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query: args.query, limit: args.max_pages ?? 5 }),
    });
    if (!res.ok) {
      const err = Object.assign(new Error(`Firecrawl search failed: ${res.status}`), {
        status: res.status,
      });
      throw err;
    }
    return res.json() as Promise<FirecrawlSearchResponse>;
  }

  async scrape(args: { url: string }): Promise<FirecrawlScrapeResponse> {
    const res = await fetch(`${this.baseUrl}/v1/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ url: args.url, formats: ['markdown'] }),
    });
    if (!res.ok) {
      const err = Object.assign(new Error(`Firecrawl scrape failed: ${res.status}`), {
        status: res.status,
      });
      throw err;
    }
    return res.json() as Promise<FirecrawlScrapeResponse>;
  }
}

export function isDomainAllowed(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

export class FirecrawlAdapter implements WebResearchAdapter {
  private transport: FirecrawlTransport;
  private allowedDomains: string[] | undefined;

  constructor(opts: { allowedDomains?: string[] }, transport?: FirecrawlTransport) {
    this.allowedDomains = opts.allowedDomains;
    this.transport = transport ?? new DefaultFirecrawlTransport();
  }

  async search(args: {
    query: string;
    max_pages?: number;
    allowed_domains?: string[] | null;
  }): Promise<WebResearchResult[]> {
    const response = await this.transport.search({
      query: args.query,
      max_pages: args.max_pages,
    });
    const topLevelBilled = response.source_billed_usd;

    let items = response.data;
    if (args.allowed_domains && args.allowed_domains.length > 0) {
      items = items.filter((item) => {
        try {
          const hostname = new URL(item.url).hostname;
          return isDomainAllowed(hostname, args.allowed_domains!);
        } catch {
          return false;
        }
      });
    }

    return items.map((item) => ({
      url: item.url,
      title: item.title ?? '',
      markdown: item.markdown ?? '',
      fetched_at: new Date().toISOString(),
      source_provider: 'firecrawl' as const,
      source_billed_usd: topLevelBilled ?? item.source_billed_usd,
    }));
  }

  async scrape(args: { url: string }): Promise<WebResearchResult> {
    // Re-verify domain against allowlist before hitting the API (handles redirect destinations).
    if (this.allowedDomains && this.allowedDomains.length > 0) {
      const hostname = new URL(args.url).hostname;
      if (!isDomainAllowed(hostname, this.allowedDomains)) {
        // Throw a string so rejects.toMatch() works in tests without coercion.
        throw `domain not allowed: ${hostname}`;
      }
    }
    const response = await this.transport.scrape({ url: args.url });
    return {
      url: response.data.url ?? args.url,
      title: response.data.title ?? '',
      markdown: response.data.markdown ?? '',
      fetched_at: new Date().toISOString(),
      source_provider: 'firecrawl' as const,
      source_billed_usd: response.source_billed_usd ?? response.data.source_billed_usd,
    };
  }
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof Error) {
    const e = err as Error & { status?: number; statusCode?: number };
    if (e.status === 401 || e.statusCode === 401) return true;
    if (/unauthorized|401/i.test(e.message)) return true;
  }
  return false;
}

class FirecrawlWithFallbackAdapter implements WebResearchAdapter {
  constructor(
    private primary: FirecrawlAdapter,
    private fallback: WebFetchAdapter,
  ) {}

  async search(args: {
    query: string;
    max_pages?: number;
    allowed_domains?: string[] | null;
  }): Promise<WebResearchResult[]> {
    try {
      return await this.primary.search(args);
    } catch (err) {
      if (isUnauthorized(err)) return this.fallback.search(args);
      throw err;
    }
  }

  async scrape(args: { url: string }): Promise<WebResearchResult> {
    try {
      return await this.primary.scrape(args);
    } catch (err) {
      if (isUnauthorized(err)) return this.fallback.scrape(args);
      throw err;
    }
  }
}

export function createResearchAdapter(
  opts: {
    provider: 'firecrawl' | 'webfetch' | 'off';
    allowedDomains?: string[];
  },
  transport?: FirecrawlTransport,
): WebResearchAdapter {
  if (opts.provider === 'off') return new OffAdapter();
  if (opts.provider === 'webfetch') return new WebFetchAdapter();
  const primary = new FirecrawlAdapter({ allowedDomains: opts.allowedDomains }, transport);
  return new FirecrawlWithFallbackAdapter(primary, new WebFetchAdapter());
}
