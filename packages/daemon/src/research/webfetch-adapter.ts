import type { WebResearchAdapter, WebResearchResult } from "../../../core/src/research/types.js";

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHostnameAllowed(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

// Fail-closed: block hosts that resolve to internal/metadata addresses regardless of
// the configured allowlist. Matches RFC1918, loopback, link-local (incl. cloud
// metadata 169.254.169.254), IPv6 loopback/link-local/unique-local, and common
// metadata hostnames. The check is hostname-only and does not perform DNS
// resolution, so a public DNS name that resolves to an internal IP can still
// slip through — pair with an allowlist for full coverage.
export function isInternalOrMetadataHost(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;

  if (h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }

  return false;
}

export class WebFetchAdapter implements WebResearchAdapter {
  private allowedDomains: string[] | undefined;

  constructor(opts: { allowedDomains?: string[] } = {}) {
    this.allowedDomains = opts.allowedDomains;
  }

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
    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch {
      throw `invalid URL: ${args.url}`;
    }
    const hostname = parsed.hostname;

    if (isInternalOrMetadataHost(hostname)) {
      throw `internal host blocked: ${hostname}`;
    }
    if (this.allowedDomains && this.allowedDomains.length > 0) {
      if (!isHostnameAllowed(hostname, this.allowedDomains)) {
        throw `domain not allowed: ${hostname}`;
      }
    }

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
