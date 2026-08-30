import type { WebResearchAdapter, WebResearchResult } from "@penumbra/core";

import { OffAdapter } from "./off-adapter.js";
import { WebFetchAdapter } from "./webfetch-adapter.js";

// Injectable transport — real impl hits the Firecrawl HTTP API; test stubs override.
export interface FirecrawlTransport {
  search(args: {
    query: string;
    max_pages?: number;
    includeDomains?: string[];
    ignoreInvalidURLs?: boolean;
  }): Promise<FirecrawlSearchResponse>;
  scrape(args: { url: string }): Promise<FirecrawlScrapeResponse>;
}

export interface FirecrawlSearchResponse {
  data: {
    url: string;
    title?: string;
    markdown?: string;
    source_billed_usd?: number;
  }[];
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function normalizeFirecrawlSearchResponse(json: unknown): FirecrawlSearchResponse {
  const root = asRecord(json);
  const data = asRecord(root?.data);
  const rawItems = Array.isArray(data?.web) ? data.web : Array.isArray(root?.data) ? root.data : [];

  return {
    data: rawItems
      .map((rawItem) => {
        const item = asRecord(rawItem) ?? {};
        const url =
          typeof item.url === "string"
            ? item.url
            : typeof item.url === "number"
              ? String(item.url)
              : "";
        const markdown =
          typeof item.markdown === "string" && item.markdown.length > 0
            ? item.markdown
            : typeof item.description === "string"
              ? item.description
              : undefined;

        return {
          url,
          title: typeof item.title === "string" ? item.title : undefined,
          markdown,
          source_billed_usd:
            typeof item.source_billed_usd === "number" ? item.source_billed_usd : undefined,
        };
      })
      .filter((item) => item.url.length > 0),
    source_billed_usd: undefined,
  };
}

class DefaultFirecrawlTransport implements FirecrawlTransport {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.FIRECRAWL_API_KEY ?? "";
    this.baseUrl = process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev";
  }

  async search(args: {
    query: string;
    max_pages?: number;
    includeDomains?: string[];
    ignoreInvalidURLs?: boolean;
  }): Promise<FirecrawlSearchResponse> {
    const res = await fetch(`${this.baseUrl}/v2/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query: args.query,
        limit: args.max_pages ?? 5,
        includeDomains: args.includeDomains?.length ? args.includeDomains : undefined,
        ignoreInvalidURLs: true,
      }),
    });
    if (!res.ok) {
      const err = Object.assign(new Error(`Firecrawl search failed: ${String(res.status)}`), {
        status: res.status,
      });
      throw err;
    }
    const json = await res.json();
    return normalizeFirecrawlSearchResponse(json);
  }

  async scrape(args: { url: string }): Promise<FirecrawlScrapeResponse> {
    const res = await fetch(`${this.baseUrl}/v2/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ url: args.url, formats: ["markdown"] }),
    });
    if (!res.ok) {
      const err = Object.assign(new Error(`Firecrawl scrape failed: ${String(res.status)}`), {
        status: res.status,
      });
      throw err;
    }
    return await (res.json() as Promise<FirecrawlScrapeResponse>);
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
      includeDomains: args.allowed_domains ?? undefined,
      max_pages: args.max_pages,
      ignoreInvalidURLs: true,
    });
    const topLevelBilled = response.source_billed_usd;

    let items = response.data;
    const allowedDomains = args.allowed_domains;
    if (allowedDomains && allowedDomains.length > 0) {
      items = items.filter((item) => {
        try {
          const hostname = new URL(item.url).hostname;
          return isDomainAllowed(hostname, allowedDomains);
        } catch {
          return false;
        }
      });
    }

    return items.map((item) => ({
      url: item.url,
      title: item.title ?? "",
      markdown: item.markdown ?? "",
      fetched_at: new Date().toISOString(),
      source_provider: "firecrawl" as const,
      source_billed_usd: topLevelBilled ?? item.source_billed_usd,
    }));
  }

  async scrape(args: { url: string }): Promise<WebResearchResult> {
    // Re-verify domain against allowlist before hitting the API (handles redirect destinations).
    if (this.allowedDomains && this.allowedDomains.length > 0) {
      const hostname = new URL(args.url).hostname;
      if (!isDomainAllowed(hostname, this.allowedDomains)) {
        throw new Error(`domain not allowed: ${hostname}`);
      }
    }
    const response = await this.transport.scrape({ url: args.url });
    return {
      url: response.data.url ?? args.url,
      title: response.data.title ?? "",
      markdown: response.data.markdown ?? "",
      fetched_at: new Date().toISOString(),
      source_provider: "firecrawl" as const,
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
      if (isUnauthorized(err)) return await this.fallback.search(args);
      throw err;
    }
  }

  async scrape(args: { url: string }): Promise<WebResearchResult> {
    try {
      return await this.primary.scrape(args);
    } catch (err) {
      if (isUnauthorized(err)) return await this.fallback.scrape(args);
      throw err;
    }
  }
}

export function createResearchAdapter(
  opts: {
    provider: "firecrawl" | "webfetch" | "off";
    allowedDomains?: string[];
  },
  transport?: FirecrawlTransport,
): WebResearchAdapter {
  if (opts.provider === "off") return new OffAdapter();
  if (opts.provider === "webfetch")
    return new WebFetchAdapter({ allowedDomains: opts.allowedDomains });
  const primary = new FirecrawlAdapter({ allowedDomains: opts.allowedDomains }, transport);
  return new FirecrawlWithFallbackAdapter(
    primary,
    new WebFetchAdapter({ allowedDomains: opts.allowedDomains }),
  );
}
