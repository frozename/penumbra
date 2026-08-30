import type { WebResearchAdapter, WebResearchResult } from "@penumbra/core";

export class OffAdapter implements WebResearchAdapter {
  search(_args: { query: string }): Promise<WebResearchResult[]> {
    return Promise.resolve([]);
  }

  scrape(_args: { url: string }): Promise<WebResearchResult> {
    return Promise.resolve({
      url: _args.url,
      title: "",
      markdown: "",
      fetched_at: new Date().toISOString(),
      source_provider: "webfetch",
      source_billed_usd: 0,
    });
  }
}
