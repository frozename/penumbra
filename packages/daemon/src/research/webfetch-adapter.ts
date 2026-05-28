import type { WebResearchAdapter, WebResearchResult } from "../../../core/src/research/types.js";

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class WebFetchAdapter implements WebResearchAdapter {
  // Returns a search-engine URL as a navigation hint; no network call.
  // Callers can scrape the returned URL for actual content.
  async search(args: {
    query: string;
    max_pages?: number;
    allowed_domains?: string[] | null;
  }): Promise<WebResearchResult[]> {
    if (args.allowed_domains && args.allowed_domains.length > 0) {
      const allowed = args.allowed_domains.some(
        (d) => "duckduckgo.com" === d || "duckduckgo.com".endsWith("." + d),
      );
      if (!allowed) {
        // Known limitation: WebFetch only outputs DDG URL, so if DDG is not allowed, return empty.
        return [];
      }
    }
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`;
    return [
      {
        url: searchUrl,
        title: `Search: ${args.query}`,
        markdown: "",
        fetched_at: new Date().toISOString(),
        source_provider: "webfetch",
        source_billed_usd: 0,
      },
    ];
  }

  async scrape(args: { url: string }): Promise<WebResearchResult> {
    const res = await fetch(args.url);
    const html = await res.text();
    const markdown = htmlToMarkdown(html);
    return {
      url: args.url,
      title: "",
      markdown,
      fetched_at: new Date().toISOString(),
      source_provider: "webfetch",
      source_billed_usd: 0,
    };
  }
}
