export interface WebResearchAdapter {
  search(args: {
    query: string;
    max_pages?: number;
    allowed_domains?: string[] | null;
  }): Promise<WebResearchResult[]>;
  scrape(args: { url: string; depth?: number }): Promise<WebResearchResult>;
}

export interface WebResearchResult {
  url: string;
  title: string;
  markdown: string;
  fetched_at: string;
  source_provider: 'firecrawl' | 'webfetch';
  source_billed_usd?: number;
  metadata?: { author?: string; published_at?: string; word_count?: number };
}
