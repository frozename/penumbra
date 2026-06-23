import type { WebResearchAdapter, WebResearchResult } from "../../../core/src/research/types.js";

function htmlToMarkdown(html: string): string {
  return html
    .replaceAll(/<script[\s\S]*?<\/script>/gi, "")
    .replaceAll(/<style[\s\S]*?<\/style>/gi, "")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
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
function isInternalIpv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.exec(h);
  if (!m) return false;
  const [, aStr, bStr] = m;
  if (aStr === undefined || bStr === undefined) return false;
  const a = parseInt(aStr, 10);
  const b = parseInt(bStr, 10);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isInternalIpv6(h: string): boolean {
  if (h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

function isInternalHostname(h: string): boolean {
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;
  return false;
}

export function isInternalOrMetadataHost(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replaceAll(/^\[|\]$/g, "");
  return isInternalHostname(h) || isInternalIpv6(h) || isInternalIpv4(h);
}

export class WebFetchAdapter implements WebResearchAdapter {
  private allowedDomains: string[] | undefined;

  constructor(opts: { allowedDomains?: string[] } = {}) {
    this.allowedDomains = opts.allowedDomains;
  }

  // Returns a search-engine URL as a navigation hint; no network call.
  // Callers can scrape the returned URL for actual content.
  search(args: {
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
        return Promise.resolve([]);
      }
    }
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`;
    return Promise.resolve([
      {
        url: searchUrl,
        title: `Search: ${args.query}`,
        markdown: "",
        fetched_at: new Date().toISOString(),
        source_provider: "webfetch",
        source_billed_usd: 0,
      },
    ]);
  }

  private checkHost(hostname: string): void {
    if (isInternalOrMetadataHost(hostname)) {
      throw new Error(`internal host blocked: ${hostname}`);
    }
    if (this.allowedDomains && this.allowedDomains.length > 0) {
      if (!isHostnameAllowed(hostname, this.allowedDomains)) {
        throw new Error(`domain not allowed: ${hostname}`);
      }
    }
  }

  private resolveRedirect(res: Response, currentUrl: string): string | null {
    const loc = res.headers.get("location");
    if (!loc) return null;
    let nextUrl: URL;
    try {
      nextUrl = new URL(loc, currentUrl);
    } catch {
      throw new Error(`invalid redirect URL: ${loc}`);
    }
    this.checkHost(nextUrl.hostname);
    return nextUrl.toString();
  }

  async scrape(args: { url: string }): Promise<WebResearchResult> {
    let currentUrl: string;
    try {
      currentUrl = new URL(args.url).toString();
    } catch {
      throw new Error(`invalid URL: ${args.url}`);
    }
    this.checkHost(new URL(currentUrl).hostname);

    // Manual redirect following: re-check each redirect target against the
    // private-host blocker AND the allowlist. Without this, a 302 to a cloud
    // metadata IP or non-allowlisted host bypasses scrape-time validation.
    const maxRedirects = 5;
    let res: Response | undefined;
    for (let hops = 0; hops <= maxRedirects; hops++) {
      res = await fetch(currentUrl, { redirect: "manual" });
      if (res.status < 300 || res.status >= 400) break;
      const next = this.resolveRedirect(res, currentUrl);
      if (next === null) break;
      currentUrl = next;
    }
    if (!res) throw new Error(`fetch failed: ${args.url}`);
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`too many redirects: ${args.url}`);
    }
    const html = await res.text();
    const markdown = htmlToMarkdown(html);
    return {
      url: currentUrl,
      title: "",
      markdown,
      fetched_at: new Date().toISOString(),
      source_provider: "webfetch",
      source_billed_usd: 0,
    };
  }
}
